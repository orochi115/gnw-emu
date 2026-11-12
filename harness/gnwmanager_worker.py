"""Actual GnW API worker; lifetime is bounded by harness.gnwmanager's parent."""
import contextlib
import importlib.resources
import json
import sys

from harness.gnwmanager import validate_firmware


def baseline(backend, gnw, _parameters):
    backend.reset_and_halt()
    registers = {name: backend.read_register(name) for name in ("pc", "msp")}
    saved = backend.read_register("r0")
    try:
        backend.write_register("r0", 0x11223344)
        assert backend.read_register("r0") == 0x11223344
    finally:
        backend.write_register("r0", saved)
    assert backend.read_register("r0") == saved
    # Current pinned backend calls p10; target ARM XML uses regnum25. Record
    # the demonstrated failure here; transport compatibility is the next task.
    try:
        registers["xpsr"] = backend.read_register("xpsr")
    except Exception as error:
        registers["xpsrError"] = repr(error)
    supported = backend._send_command(b"qSupported").decode("ascii")
    packet_size = next(int(item.split("=", 1)[1], 16) for item in supported.split(";")
                       if item.startswith("PacketSize="))
    data = bytes(range(256)) * 257
    backend.write_memory(0x24010000, data)
    assert backend.read_memory(0x24010000, len(data)) == data
    gnw.start_gnwmanager(resume=False)
    loaded_pc = backend.read_register("pc")
    backend.resume()
    gnw.wait_for_idle(timeout=5)
    return {"registers": registers, "registerRoundtrip": "restored",
            "packetSize": packet_size, "ramBytes": len(data), "loadedPc": loaded_pc,
            "status": gnw._get_status(), "flashBytes": gnw.external_flash_size,
            "eraseBytes": gnw.external_flash_block_size}


OPERATIONS = {"baseline": baseline}


def main():
    from gnwmanager import GnW
    from gnwmanager.ocdbackend import GDBBackend

    config = json.loads(sys.argv[1])
    firmware = importlib.resources.files("gnwmanager") / "firmware.bin"
    manifest = validate_firmware(config["manifest"], firmware)
    backend = GDBBackend(config["host"], config["port"])
    with contextlib.redirect_stdout(sys.stderr):
        try:
            backend.open()
            result = OPERATIONS[config["operation"]](backend, GnW(backend), config["parameters"])
        finally:
            backend.close()
    result.update({"firmwareBytes": manifest["artifacts"]["firmware"]["size"],
                   "firmwareSha256": manifest["artifacts"]["firmware"]["sha256"],
                   "managerRevision": manifest["source"]["revision"]})
    print(json.dumps(result))


if __name__ == "__main__":
    main()
