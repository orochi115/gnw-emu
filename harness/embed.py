"""Receive the QEMU D-Bus display inside the shell.

QEMU is started with ``-display dbus,p2p=yes``. A QMP ``add_client`` hands
it one end of a socket pair. This module speaks the peer D-Bus protocol on
the other end, registers a listener, and turns Scanout/Update into pixels.

The wire format is jeepney. No session bus is required, so the same path
works on macOS, Windows and Linux. Windows shared-memory scanout is not
implemented; QEMU falls back to Scanout/Update when Unix.Map is absent.
"""
from __future__ import annotations

import asyncio
import os
import queue
import select
import socket
import struct
import uuid
from array import array

from jeepney.low_level import HeaderFields, MessageType, Parser
from jeepney.wrappers import DBusAddress, new_method_call, new_method_return
from PySide6.QtCore import QThread, Signal
from PySide6.QtGui import QImage
from qemu.qmp import QMPClient

# pixman PIXMAN_x8r8g8b8 (32 bpp, ARGB, x=0). Little-endian matches QImage.Format_RGB32.
PIXMAN_x8r8g8b8 = 0x20020888
LISTENER_PATH = "/org/qemu/Display1/Listener"
LISTENER_IFACE = "org.qemu.Display1.Listener"


def qnum_for_qt_key(key: int) -> int | None:
    """Map a Qt key constant to the QEMU key number the D-Bus keyboard uses."""
    if 0x41 <= key <= 0x5A:  # Qt.Key_A .. Key_Z
        return {
            0x41: 0x1E, 0x42: 0x30, 0x43: 0x2E, 0x44: 0x20, 0x45: 0x12,
            0x46: 0x21, 0x47: 0x22, 0x48: 0x23, 0x49: 0x17, 0x4A: 0x24,
            0x4B: 0x25, 0x4C: 0x26, 0x4D: 0x32, 0x4E: 0x31, 0x4F: 0x18,
            0x50: 0x19, 0x51: 0x10, 0x52: 0x13, 0x53: 0x1F, 0x54: 0x14,
            0x55: 0x16, 0x56: 0x2F, 0x57: 0x11, 0x58: 0x2D, 0x59: 0x15,
            0x5A: 0x2C,
        }[key]
    return {
        0x01000013: 0xC8,  # Up
        0x01000015: 0xD0,  # Down
        0x01000012: 0xCB,  # Left
        0x01000014: 0xCD,  # Right
        0x01000004: 0x1C,  # Return
        0x01000005: 0x1C,  # Enter
        0x01000001: 0x0F,  # Tab
        0x2D: 0x0C,        # Minus
        0x3D: 0x0D,        # Equal
    }.get(key)


def image_from_xrgb(width: int, height: int, stride: int, data: bytes) -> QImage:
    image = QImage(data, width, height, stride, QImage.Format.Format_RGB32)
    return image.copy()


class _Conn:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.parser = Parser()
        self.serial = 1
        self.buf = b""

    def send(self, msg, fds=None) -> int:
        serial = self.serial
        self.serial += 1
        fd_array = array("i") if fds else None
        payload = msg.serialise(serial=serial, fds=fd_array)
        if fds:
            raw = array("i", fds).tobytes()
            self.sock.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, raw)])
        else:
            self.sock.sendall(payload)
        return serial


def _readline(sock: socket.socket, buf: bytes) -> tuple[bytes, bytes]:
    while b"\r\n" not in buf:
        chunk = sock.recv(256)
        if not chunk:
            raise EOFError("D-Bus auth closed")
        buf += chunk
    line, rest = buf.split(b"\r\n", 1)
    return line, rest


def auth_client(sock: socket.socket) -> None:
    uid = str(getattr(os, "getuid", lambda: 0)()).encode().hex().encode()
    sock.sendall(b"\0AUTH EXTERNAL " + uid + b"\r\n")
    line, _rest = _readline(sock, b"")
    if not line.startswith(b"OK"):
        raise RuntimeError(f"D-Bus client auth failed: {line!r}")
    sock.sendall(b"NEGOTIATE_UNIX_FD\r\n")
    line, _rest = _readline(sock, b"")
    if line != b"AGREE_UNIX_FD":
        raise RuntimeError(f"D-Bus unix fd negotiation failed: {line!r}")
    sock.sendall(b"BEGIN\r\n")


def auth_server(sock: socket.socket) -> None:
    buf = b""
    line, buf = _readline(sock, buf)
    if line.startswith(b"\0"):
        line = line[1:]
    if not line.startswith(b"AUTH"):
        raise RuntimeError(f"D-Bus server auth failed: {line!r}")
    guid = uuid.uuid4().hex
    sock.sendall(b"OK " + guid.encode() + b"\r\n")
    line, buf = _readline(sock, buf)
    if line == b"NEGOTIATE_UNIX_FD":
        sock.sendall(b"AGREE_UNIX_FD\r\n")
        line, _buf = _readline(sock, buf)
    if line != b"BEGIN":
        raise RuntimeError(f"D-Bus server expected BEGIN, got {line!r}")


def _call(conn: _Conn, path: str, interface: str, method: str,
          signature: str | None, body: tuple):
    address = DBusAddress(path, bus_name="org.qemu", interface=interface)
    msg = new_method_call(address, method, signature, body)
    serial = conn.send(msg)
    while True:
        reply = _next(conn)
        if reply.header.message_type == MessageType.method_return:
            if reply.header.fields.get(HeaderFields.reply_serial) == serial:
                return reply
        elif reply.header.message_type == MessageType.error:
            if reply.header.fields.get(HeaderFields.reply_serial) == serial:
                raise RuntimeError(f"{method} failed: {reply.body}")
        # Ignore signals and unrelated replies.


def _next(conn: _Conn):
    while True:
        msg = conn.parser.get_next_message()
        if msg is not None:
            return msg
        want = max(conn.parser.bytes_desired(), 1)
        data, anc, _flags, _addr = conn.sock.recvmsg(max(want, 4096), 256)
        if not data and not anc:
            raise EOFError("D-Bus connection closed")
        fds = []
        for _level, typ, payload in anc:
            if typ == socket.SCM_RIGHTS:
                for offset in range(0, len(payload), 4):
                    fds.append(struct.unpack_from("i", payload, offset)[0])
        conn.parser.add_data(data, fds)


def _reply(conn: _Conn, call, signature=None, body=()):
    conn.send(new_method_return(call, signature, body))


class DisplaySession(QThread):
    """Background thread: QMP attach, then frames from the listener."""

    frame = Signal(QImage)
    failed = Signal(str)
    attached = Signal()

    def __init__(self, qmp_path: str):
        super().__init__()
        self.qmp_path = qmp_path
        self._console = "/org/qemu/Display1/Console_0"
        self._client: _Conn | None = None
        self._stop = False
        self._keys: queue.Queue[tuple[int, bool]] = queue.Queue()
        self._wake_r, self._wake_w = socket.socketpair()

    def stop(self) -> None:
        self._stop = True

    def key(self, qnum: int, down: bool) -> None:
        self._keys.put((qnum, down))
        try:
            self._wake_w.send(b"\0")
        except OSError:
            return

    def run(self) -> None:
        try:
            self._run()
        except Exception as exc:
            if not self._stop:
                self.failed.emit(str(exc))

    def _run(self) -> None:
        qemu_end, our_end = socket.socketpair()
        listen_qemu, listen_ours = socket.socketpair()
        try:
            asyncio.run(self._add_client(qemu_end.fileno()))
            qemu_end.close()
            auth_client(our_end)
            client = _Conn(our_end)
            self._client = client
            ids = _call(
                client, "/org/qemu/Display1/VM",
                "org.freedesktop.DBus.Properties", "Get", "ss",
                ("org.qemu.Display1.VM", "ConsoleIDs"))
            numbers = ids.body[0][1]
            if numbers:
                self._console = f"/org/qemu/Display1/Console_{numbers[0]}"
            address = DBusAddress(
                self._console, bus_name="org.qemu",
                interface="org.qemu.Display1.Console")
            msg = new_method_call(address, "RegisterListener", "h",
                                  (listen_qemu.fileno(),))
            fd_array = array("i")
            payload = msg.serialise(serial=client.serial, fds=fd_array)
            client.serial += 1
            client.sock.sendmsg(
                [payload],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fd_array.tobytes())])
            listen_qemu.close()
            # QEMU opens this socket as AUTHENTICATION_SERVER, so we authenticate
            # as the client. It then calls Scanout/Update on us.
            auth_client(listen_ours)
            listener = _Conn(listen_ours)
            self.attached.emit()
            self._frames(client, listener)
        finally:
            for sock in (qemu_end, our_end, listen_qemu, listen_ours):
                try:
                    sock.close()
                except OSError:
                    pass

    async def _add_client(self, fd: int) -> None:
        last = "QMP did not come up"
        qmp = None
        for _ in range(50):
            qmp = QMPClient()
            try:
                await qmp.connect(self.qmp_path)
                break
            except Exception as exc:
                last = str(exc)
                await asyncio.sleep(0.1)
        else:
            raise RuntimeError(f"{last}: {self.qmp_path}")
        assert qmp is not None
        qmp.send_fd_scm(fd)
        await qmp.execute("getfd", {"fdname": "dbus"})
        await qmp.execute("add_client",
                          {"protocol": "@dbus-display", "fdname": "dbus"})
        await qmp.disconnect()

    def _flush_keys(self, client: _Conn) -> None:
        while True:
            try:
                qnum, down = self._keys.get_nowait()
            except queue.Empty:
                return
            address = DBusAddress(
                self._console, bus_name="org.qemu",
                interface="org.qemu.Display1.Keyboard")
            msg = new_method_call(address, "Press" if down else "Release",
                                  "u", (qnum,))
            client.send(msg)

    def _frames(self, client: _Conn, listener: _Conn) -> None:
        pixels = b""
        width = height = stride = 0
        pending = {client.sock, listener.sock, self._wake_r}
        while not self._stop:
            readable, _, _ = select.select(pending, [], [], 0.2)
            if self._wake_r in readable:
                self._wake_r.recv(64)
                self._flush_keys(client)
            for sock in readable:
                if sock is self._wake_r:
                    continue
                conn = client if sock is client.sock else listener
                try:
                    msg = _next(conn)
                except EOFError:
                    return
                if conn is client:
                    continue
                self._on_listener(conn, msg, pixels, width, height, stride)
                member = msg.header.fields.get(HeaderFields.member)
                if member == "Scanout" and len(msg.body) >= 5 and msg.body[3] == PIXMAN_x8r8g8b8:
                    width, height, stride = msg.body[0], msg.body[1], msg.body[2]
                    pixels = bytes(msg.body[4])
                    self.frame.emit(image_from_xrgb(width, height, stride, pixels))
                elif (member == "Update" and pixels and len(msg.body) >= 7
                      and msg.body[5] == PIXMAN_x8r8g8b8):
                    pixels = _paste(pixels, width, stride,
                                    msg.body[0], msg.body[1], msg.body[2],
                                    msg.body[3], bytes(msg.body[6]), msg.body[4])
                    self.frame.emit(image_from_xrgb(width, height, stride, pixels))

    def _on_listener(self, conn, msg, pixels, width, height, stride) -> None:
        member = msg.header.fields.get(HeaderFields.member)
        iface = msg.header.fields.get(HeaderFields.interface, "")
        if member == "Get" and iface.endswith("Properties"):
            prop = msg.body[1]
            if prop == "Interfaces":
                _reply(conn, msg, "v", (("as", [LISTENER_IFACE]),))
            else:
                _reply(conn, msg, "v", (("u", 0),))
            return
        if member == "GetAll":
            _reply(conn, msg, "a{sv}", ([
                ("Interfaces", ("as", [LISTENER_IFACE])),
            ],))
            return
        if member in ("Scanout", "Update", "Disable", "MouseSet", "CursorDefine"):
            _reply(conn, msg)
            return
        _reply(conn, msg)


def _paste(base: bytes, width: int, stride: int,
           x: int, y: int, w: int, h: int, src: bytes, src_stride: int) -> bytes:
    buf = bytearray(base)
    for row in range(h):
        dst_at = (y + row) * stride + x * 4
        src_at = row * src_stride
        buf[dst_at:dst_at + w * 4] = src[src_at:src_at + w * 4]
    return bytes(buf)
