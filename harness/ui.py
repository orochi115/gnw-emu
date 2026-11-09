"""Desktop launcher: Open, Open Recent, and a Make form.

    python -m harness.ui

Open and Open Recent start python -m harness.launch, which owns the
session and the recent list. Make writes a .gnw.toml through the system
save dialog. The device uid is generated when the form opens and is not
editable. There is no save-directory field; sessions stay in UserData.
"""
from __future__ import annotations

import secrets
import sys
from pathlib import Path

import tempfile

from PySide6.QtCore import QProcess, Qt
from PySide6.QtGui import QImage
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QFormLayout, QHBoxLayout,
    QLabel, QLineEdit, QMainWindow, QMessageBox, QPushButton, QVBoxLayout,
    QWidget,
)

from .embed import DisplaySession, qnum_for_qt_key
from .launch import QEMU
from .profile import (
    ROOT, SETTINGS_PATH, ProfileError, apply_env, load_profile, load_settings,
    prepare_session, qemu_argv, read_state_file, remember_profile,
    save_runtime_state, write_profile,
)

PROFILE_FILTER = "GNW profile (*.gnw.toml)"


def new_uid() -> str:
    return secrets.token_hex(12)


def validate_make(fields: dict) -> list[str]:
    """Return human-readable problems. An empty list means the form can save."""
    errors = []
    if fields.get("model") not in ("zelda", "mario"):
        errors.append("model 只能是 zelda 或 mario")
    for key, label in (("internal", "internal"), ("external", "external")):
        value = fields.get(key) or ""
        if not value:
            errors.append(f"{label} 必填")
        elif not Path(value).is_file():
            errors.append(f"{label} 找不到文件")
    for key in ("bank2", "sdcard"):
        value = fields.get(key) or ""
        if value and not Path(value).is_file():
            errors.append(f"{key} 找不到文件")
    wiring = fields.get("sd-wiring") or ""
    if fields.get("sdcard"):
        if wiring not in ("spi1", "ospi"):
            errors.append("sd-wiring 只能是 spi1 或 ospi")
    elif wiring and wiring not in ("spi1", "ospi"):
        errors.append("sd-wiring 只能是 spi1 或 ospi")
    uid = fields.get("uid") or ""
    if len(uid) != 24 or any(c not in "0123456789abcdefABCDEF" for c in uid):
        errors.append("uid 必须是 24 位十六进制")
    return errors


class MakeDialog(QWidget):
    def __init__(self, launch):
        super().__init__()
        self._launch = launch
        self.setWindowTitle("Make")
        self.setMinimumWidth(560)
        form = QFormLayout()

        self.model = QComboBox()
        self.model.addItems(["zelda", "mario"])
        form.addRow("model", self.model)

        self.internal = self._path_row(form, "internal", required=True)
        self.external = self._path_row(form, "external", required=True)
        self.bank2 = self._path_row(form, "bank2", required=False)
        self.sdcard = self._path_row(form, "sdcard", required=False)

        self.wiring = QComboBox()
        self.wiring.addItems(["spi1", "ospi"])
        self.wiring.setEnabled(False)
        form.addRow("sd-wiring", self.wiring)
        self.sdcard.textChanged.connect(self._sync_wiring)

        self.uid = QLineEdit(new_uid())
        self.uid.setReadOnly(True)
        form.addRow("uid", self.uid)

        buttons = QHBoxLayout()
        save = QPushButton("保存…")
        save_launch = QPushButton("保存并启动…")
        save.clicked.connect(lambda: self._save(launch_after=False))
        save_launch.clicked.connect(lambda: self._save(launch_after=True))
        buttons.addWidget(save)
        buttons.addWidget(save_launch)
        buttons.addStretch(1)

        note = QLabel("保存时选择 .gnw.toml 的位置。镜像路径按那个文件写成相对路径。"
                      "电量和存档在 UserData，不在这张表里。")
        note.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(note)
        layout.addLayout(buttons)

    def _path_row(self, form: QFormLayout, name: str, *, required: bool) -> QLineEdit:
        edit = QLineEdit()
        edit.setPlaceholderText("必填" if required else "可选")
        button = QPushButton("浏览…")
        button.clicked.connect(lambda: self._browse(edit))
        row = QHBoxLayout()
        row.addWidget(edit, 1)
        row.addWidget(button)
        form.addRow(name, row)
        return edit

    def _browse(self, edit: QLineEdit) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择镜像", edit.text())
        if path:
            edit.setText(path)

    def _sync_wiring(self, text: str) -> None:
        self.wiring.setEnabled(bool(text.strip()))

    def fields(self) -> dict:
        data = {
            "model": self.model.currentText(),
            "internal": self.internal.text().strip(),
            "external": self.external.text().strip(),
            "bank2": self.bank2.text().strip(),
            "sdcard": self.sdcard.text().strip(),
            "uid": self.uid.text().strip(),
        }
        if data["sdcard"]:
            data["sd-wiring"] = self.wiring.currentText()
        return data

    def _save(self, *, launch_after: bool) -> None:
        fields = self.fields()
        errors = validate_make(fields)
        if errors:
            QMessageBox.warning(self, "Make", "\n".join(errors))
            return
        dest, _ = QFileDialog.getSaveFileName(
            self, "保存 profile", "machine.gnw.toml", PROFILE_FILTER)
        if not dest:
            return
        path = Path(dest)
        if not path.name.endswith(".gnw.toml"):
            path = path.with_name(path.name + ".gnw.toml")
        try:
            write_profile(path, fields["model"], fields)
        except ProfileError as exc:
            QMessageBox.warning(self, "Make", str(exc))
            return
        if launch_after:
            self._launch(path)


class Screen(QWidget):
    """Guest framebuffer. Keys go to QEMU while this widget has focus."""

    def __init__(self, send_key):
        super().__init__()
        self._send_key = send_key
        self._image: QImage | None = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMinimumSize(480, 320)
        self.setStyleSheet("background: black;")

    def set_frame(self, image: QImage) -> None:
        self._image = image
        self.update()

    def paintEvent(self, _event) -> None:
        from PySide6.QtGui import QPainter
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.black)
        if self._image is None or self._image.isNull():
            return
        scaled = self._image.scaled(
            self.size(), Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation)
        x = (self.width() - scaled.width()) // 2
        y = (self.height() - scaled.height()) // 2
        painter.drawImage(x, y, scaled)

    def keyPressEvent(self, event) -> None:
        if event.isAutoRepeat():
            return
        qnum = qnum_for_qt_key(int(event.key()))
        if qnum is not None:
            self._send_key(qnum, True)

    def keyReleaseEvent(self, event) -> None:
        if event.isAutoRepeat():
            return
        qnum = qnum_for_qt_key(int(event.key()))
        if qnum is not None:
            self._send_key(qnum, False)


class Launcher(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("gnw-emu")
        self.resize(720, 480)
        self._process: QProcess | None = None
        self._display: DisplaySession | None = None
        self._session = None
        self._make: MakeDialog | None = None
        self._qmp_path = ""

        self.screen = Screen(self._send_key)
        self.status = QLabel("File → Open 打开一份 .gnw.toml。画面画在这个窗口里。")
        self.status.setContentsMargins(8, 4, 8, 4)
        body = QWidget()
        layout = QVBoxLayout(body)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.screen, 1)
        layout.addWidget(self.status)
        self.setCentralWidget(body)

        file_menu = self.menuBar().addMenu("File")
        file_menu.addAction("Open…", self.open_profile)
        self.recent_menu = file_menu.addMenu("Open Recent")
        self.recent_menu.aboutToShow.connect(self._fill_recent)
        file_menu.addSeparator()
        file_menu.addAction("Make…", self.open_make)

    def _fill_recent(self) -> None:
        self.recent_menu.clear()
        try:
            settings = load_settings(SETTINGS_PATH, write=False)
        except ProfileError as exc:
            action = self.recent_menu.addAction(str(exc))
            action.setEnabled(False)
            return
        paths = [item for item in settings.recent if Path(item).is_file()]
        if not paths:
            action = self.recent_menu.addAction("空")
            action.setEnabled(False)
            return
        for item in paths:
            self.recent_menu.addAction(Path(item).name, lambda p=item: self.launch(Path(p)))

    def open_profile(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Open", str(ROOT), PROFILE_FILTER)
        if path:
            self.launch(Path(path))

    def open_make(self) -> None:
        if self._make is None:
            self._make = MakeDialog(self.launch)
        self._make.show()
        self._make.raise_()
        self._make.activateWindow()

    def _send_key(self, qnum: int, down: bool) -> None:
        if self._display is not None:
            self._display.key(qnum, down)

    def launch(self, profile: Path) -> None:
        if not QEMU.is_file():
            QMessageBox.warning(self, "gnw-emu", f"qemu 还没编译：{QEMU}")
            return
        if self._process is not None and self._process.state() != QProcess.ProcessState.NotRunning:
            QMessageBox.information(self, "gnw-emu", "已经有一台机器在运行。")
            return
        try:
            settings = load_settings(SETTINGS_PATH, write=True)
            loaded = load_profile(profile)
            session = prepare_session(loaded)
            session, settings = apply_env(session, settings)
            remember_profile(settings, loaded.path)
            qmp = tempfile.NamedTemporaryFile(
                prefix="gnw-qmp-", suffix=".sock", delete=False)
            qmp.close()
            Path(qmp.name).unlink(missing_ok=True)
            command = qemu_argv(
                QEMU, loaded, session, settings,
                display="dbus,p2p=yes")
            command += ["-qmp", f"unix:{qmp.name},server=on,wait=off"]
        except (ProfileError, ValueError, OSError) as exc:
            QMessageBox.warning(self, "gnw-emu", str(exc))
            return
        self._session = session
        self._qmp_path = qmp.name
        process = QProcess(self)
        process.setProgram(command[0])
        process.setArguments(command[1:])
        process.setWorkingDirectory(str(ROOT))
        process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        process.finished.connect(self._finished)
        process.start()
        self._process = process
        display = DisplaySession(qmp.name)
        display.frame.connect(self.screen.set_frame)
        display.failed.connect(self.status.setText)
        display.attached.connect(lambda: self.screen.setFocus())
        display.start()
        self._display = display
        self.status.setText(f"正在运行 {profile.name}")
        self.screen.setFocus()

    def _finished(self, code: int, _status) -> None:
        if self._display is not None:
            self._display.stop()
            self._display.wait(2000)
            self._display = None
        if self._qmp_path:
            Path(self._qmp_path).unlink(missing_ok=True)
            self._qmp_path = ""
        if self._session is not None:
            state = read_state_file(self._session.state_file)
            if state is not None:
                save_runtime_state(self._session, *state)
                self._session.state_file.unlink(missing_ok=True)
            self._session = None
        if code == 0:
            self.status.setText("已退出")
        else:
            text = ""
            if self._process is not None:
                text = bytes(self._process.readAllStandardOutput()).decode(
                    "utf-8", "replace").strip()
            self.status.setText(text.splitlines()[-1] if text else f"退出码 {code}")


def main() -> int:
    app = QApplication(sys.argv)
    window = Launcher()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
