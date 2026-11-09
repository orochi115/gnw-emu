"""ROM profile, per-machine session, and host-wide settings.

See docs/profiles.md. A profile names the read-only images. A session
holds battery, RTC, and the paths of the writable flash copies. Settings
hold audio, the display backend, and realtime pacing.

Image paths in a profile are relative to the profile file. Writable
copies live under UserData/sessions/<profile id>/. The same directory is
used on every platform; it sits next to the emulator, not in a
platform-specific settings folder.
"""
from __future__ import annotations

import os
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USERDATA = ROOT / "UserData"
SETTINGS_PATH = USERDATA / "settings.toml"
SESSIONS = USERDATA / "sessions"
RECENT_LIMIT = 10

PROFILE_VERSION = 1
SESSION_VERSION = 1
SETTINGS_VERSION = 1


class ProfileError(Exception):
    pass


def _parse_array(value: str, path: Path, lineno: int) -> list[str]:
    if not value.endswith("]"):
        raise ProfileError(f"{path}:{lineno}: unclosed array")
    inner = value[1:-1].strip()
    if not inner:
        return []
    items = []
    for part in inner.split(","):
        part = part.strip()
        if len(part) >= 2 and part[0] == part[-1] and part[0] in "\"'":
            items.append(part[1:-1])
        else:
            raise ProfileError(f"{path}:{lineno}: array items must be strings")
    return items


def _parse(text: str, path: Path) -> dict:
    """Subset of TOML: comments, key = string | int | bool | string array."""
    values: dict = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if "=" not in line:
            raise ProfileError(f"{path}:{lineno}: expected key = value")
        key, value = (part.strip() for part in line.split("=", 1))
        if not key:
            raise ProfileError(f"{path}:{lineno}: missing key")
        if value.startswith("["):
            values[key] = _parse_array(value, path, lineno)
        elif len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            values[key] = value[1:-1]
        elif value in ("true", "false"):
            values[key] = value == "true"
        elif value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
            values[key] = int(value)
        else:
            raise ProfileError(f"{path}:{lineno}: unsupported value {value!r}")
    return values


def _quote(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_quote(item) for item in value) + "]"
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def default_display() -> str:
    if sys.platform == "darwin":
        return "cocoa,zoom-to-fit=on"
    return "gtk,zoom-to-fit=on"


def _check_id(value: str, path: Path) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise ProfileError(f"{path}: id must be a UUID") from exc


def _dump(values: dict) -> str:
    return "".join(f"{key} = {_quote(value)}\n" for key, value in values.items())


def _load_file(path: Path) -> dict:
    try:
        text = path.read_text()
    except OSError as exc:
        raise ProfileError(f"cannot read {path}: {exc}") from exc
    return _parse(text, path)


def _require(data: dict, key: str, path: Path):
    if key not in data or data[key] == "":
        raise ProfileError(f"{path}: missing {key}")
    return data[key]


def _resolve(base: Path, value: str, path: Path, key: str) -> Path:
    if "\n" in value or "," in value:
        raise ProfileError(f"{path}: {key} cannot contain a comma or newline")
    return (base / value).resolve() if not Path(value).is_absolute() else Path(value)


@dataclass
class Profile:
    path: Path
    id: str
    model: str
    internal: Path
    external: Path
    bank2: Path | None = None
    sdcard: Path | None = None
    sd_wiring: str | None = None
    uid: str | None = None

    @property
    def stem(self) -> str:
        name = self.path.name
        suffix = ".gnw.toml"
        if name.endswith(suffix):
            return name[: -len(suffix)]
        return self.path.stem


@dataclass
class Session:
    directory: Path
    battery: int = 100
    usb_power: bool = False
    battery_life_min: int = 480
    charge_time_min: int = 180
    rtc: str = "host"
    overlay: Path | None = None
    bank1_overlay: Path | None = None
    bank2_overlay: Path | None = None
    sdcard: Path | None = None
    profile_path: str = ""
    # Paths as written in session.toml (may be relative).
    _raw: dict = field(default_factory=dict, repr=False)

    @property
    def state_file(self) -> Path:
        return self.directory / "state.txt"


@dataclass
class Settings:
    audio: bool = True
    display: str = field(default_factory=default_display)
    realtime: bool = True
    recent: list[str] = field(default_factory=list)
    path: Path = SETTINGS_PATH


def session_directory(profile_id: str, sessions: Path = SESSIONS) -> Path:
    return sessions / _check_id(profile_id, sessions)


def load_profile(path: Path) -> Profile:
    path = path.resolve()
    if path.name.endswith(".toml") and not path.name.endswith(".gnw.toml"):
        raise ProfileError(f"{path}: profile name must end with .gnw.toml")
    if not path.name.endswith(".gnw.toml"):
        raise ProfileError(f"{path}: profile name must end with .gnw.toml")
    data = _load_file(path)
    version = data.get("version")
    if version != PROFILE_VERSION:
        raise ProfileError(f"{path}: version must be {PROFILE_VERSION}")
    model = _require(data, "model", path)
    if model not in ("zelda", "mario"):
        raise ProfileError(f"{path}: model must be zelda or mario")
    base = path.parent
    internal = _resolve(base, str(_require(data, "internal", path)), path, "internal")
    external = _resolve(base, str(_require(data, "external", path)), path, "external")
    for label, image in (("internal", internal), ("external", external)):
        if not image.is_file():
            raise ProfileError(f"{path}: {label} image not found: {image}")
    bank2 = None
    if data.get("bank2"):
        bank2 = _resolve(base, str(data["bank2"]), path, "bank2")
        if not bank2.is_file():
            raise ProfileError(f"{path}: bank2 image not found: {bank2}")
    sdcard = None
    if data.get("sdcard"):
        sdcard = _resolve(base, str(data["sdcard"]), path, "sdcard")
        if not sdcard.is_file():
            raise ProfileError(f"{path}: sdcard image not found: {sdcard}")
    wiring = data.get("sd-wiring")
    if wiring not in (None, "", "spi1", "ospi"):
        raise ProfileError(f"{path}: sd-wiring must be spi1 or ospi")
    if wiring and sdcard is None:
        raise ProfileError(f"{path}: sd-wiring is set but sdcard is not")
    if not sdcard:
        wiring = None
    uid = data.get("uid") or None
    if uid is not None:
        if len(uid) != 24 or any(c not in "0123456789abcdefABCDEF" for c in uid):
            raise ProfileError(f"{path}: uid must be 24 hex digits")
    if not data.get("id"):
        raise ProfileError(f"{path}: missing id")
    return Profile(path, _check_id(str(data["id"]), path), model, internal,
                   external, bank2, sdcard, wiring or None, uid)


def _settings_text(settings: Settings) -> dict:
    return {
        "version": SETTINGS_VERSION,
        "audio": settings.audio,
        "display": settings.display,
        "realtime": settings.realtime,
        "recent": list(settings.recent),
    }


def load_settings(path: Path = SETTINGS_PATH, *, write: bool = False) -> Settings:
    settings = Settings(path=path)
    if path.is_file():
        data = _load_file(path)
        version = data.get("version")
        if version != SETTINGS_VERSION:
            raise ProfileError(f"{path}: version must be {SETTINGS_VERSION}")
        if "audio" in data:
            settings.audio = bool(data["audio"])
        if "display" in data:
            settings.display = str(data["display"])
        if "realtime" in data:
            settings.realtime = bool(data["realtime"])
        recent = data.get("recent", [])
        if isinstance(recent, str):
            recent = [recent]
        if not isinstance(recent, list):
            raise ProfileError(f"{path}: recent must be an array of paths")
        settings.recent = [str(item) for item in recent]
    elif write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_dump(_settings_text(settings)))
    return settings


def remember_profile(settings: Settings, profile_path: Path) -> Settings:
    """Put this profile at the front of the recent list and drop missing files."""
    absolute = str(Path(profile_path).resolve())
    kept = []
    for item in [absolute, *settings.recent]:
        if item in kept:
            continue
        if item != absolute and not Path(item).is_file():
            continue
        kept.append(item)
        if len(kept) == RECENT_LIMIT:
            break
    settings.recent = kept
    settings.path.parent.mkdir(parents=True, exist_ok=True)
    settings.path.write_text(_dump(_settings_text(settings)))
    return settings


def _session_from_data(directory: Path, data: dict) -> Session:
    def image(key: str) -> Path | None:
        raw = data.get(key) or ""
        if not raw:
            return None
        candidate = Path(str(raw))
        if not candidate.is_absolute():
            candidate = directory / candidate
        return candidate

    return Session(
        directory=directory,
        battery=int(data.get("battery", 100)),
        usb_power=bool(data.get("usb-power", False)),
        battery_life_min=int(data.get("battery-life-min", 480)),
        charge_time_min=int(data.get("charge-time-min", 180)),
        rtc=str(data.get("rtc", "host")),
        overlay=image("overlay"),
        bank1_overlay=image("bank1-overlay"),
        bank2_overlay=image("bank2-overlay"),
        sdcard=image("sdcard"),
        profile_path=str(data.get("profile") or ""),
        _raw=dict(data),
    )


def _default_session_text(profile: Profile) -> dict:
    data = {
        "version": SESSION_VERSION,
        "battery": 100,
        "usb-power": False,
        "battery-life-min": 480,
        "charge-time-min": 180,
        "rtc": "host",
        "profile": str(profile.path.resolve()),
        "overlay": "flash.bin",
        "bank1-overlay": "bank1.bin",
        "bank2-overlay": "bank2.bin" if profile.bank2 else "",
        "sdcard": "sdcard.img" if profile.sdcard else "",
    }
    return data


def prepare_session(profile: Profile, sessions: Path = SESSIONS) -> Session:
    directory = session_directory(profile.id, sessions)
    directory.mkdir(parents=True, exist_ok=True)
    session_path = directory / "session.toml"
    if not session_path.is_file():
        session_path.write_text(_dump(_default_session_text(profile)))
    data = _load_file(session_path)
    if data.get("version") != SESSION_VERSION:
        raise ProfileError(f"{session_path}: version must be {SESSION_VERSION}")
    data["profile"] = str(profile.path.resolve())
    if profile.sdcard and not data.get("sdcard"):
        data["sdcard"] = "sdcard.img"
    session_path.write_text(_dump(data))
    session = _session_from_data(directory, data)
    copies = [(session.overlay, profile.external),
              (session.bank1_overlay, profile.internal)]
    if profile.bank2 and session.bank2_overlay:
        copies.append((session.bank2_overlay, profile.bank2))
    if profile.sdcard and session.sdcard:
        copies.append((session.sdcard, profile.sdcard))
    for dest, source in copies:
        if dest is None or dest.is_file():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    return session


def save_runtime_state(session: Session, battery: int, usb_power: bool) -> None:
    """Write battery and USB back. Other session fields stay as on disk."""
    path = session.directory / "session.toml"
    data = _load_file(path) if path.is_file() else _default_session_text(
        Profile(Path("."), "00000000-0000-4000-8000-000000000000",
                "zelda", Path("."), Path(".")))
    data["battery"] = battery
    data["usb-power"] = usb_power
    path.write_text(_dump(data))


def read_state_file(path: Path) -> tuple[int, bool] | None:
    if not path.is_file():
        return None
    data = _parse(path.read_text(), path)
    if "battery" not in data or "usb-power" not in data:
        return None
    battery = int(data["battery"])
    if not 0 <= battery <= 100:
        raise ProfileError(f"{path}: battery out of range")
    return battery, bool(data["usb-power"])


def apply_env(session: Session, settings: Settings, env: dict | None = None
              ) -> tuple[Session, Settings]:
    """One-run overrides. The copies are what this launch uses."""
    env = os.environ if env is None else env
    session = Session(**{k: getattr(session, k) for k in (
        "directory", "battery", "usb_power", "battery_life_min",
        "charge_time_min", "rtc", "overlay", "bank1_overlay",
        "bank2_overlay", "sdcard", "profile_path")})
    settings = Settings(audio=settings.audio, display=settings.display,
                        realtime=settings.realtime, recent=list(settings.recent),
                        path=settings.path)
    if "BATTERY" in env and env["BATTERY"] != "":
        session.battery = int(env["BATTERY"])
    if "USB_POWER" in env and env["USB_POWER"] != "":
        session.usb_power = env["USB_POWER"] == "on"
    if "BATTERY_LIFE_MIN" in env and env["BATTERY_LIFE_MIN"] != "":
        session.battery_life_min = int(env["BATTERY_LIFE_MIN"])
    if "CHARGE_TIME_MIN" in env and env["CHARGE_TIME_MIN"] != "":
        session.charge_time_min = int(env["CHARGE_TIME_MIN"])
    if "RTC" in env and env["RTC"] != "":
        session.rtc = env["RTC"]
    if "DISPLAY_BACKEND" in env and env["DISPLAY_BACKEND"] != "":
        settings.display = env["DISPLAY_BACKEND"]
    return session, settings


def machine_options(profile: Profile, session: Session, settings: Settings,
                    *, state_file: Path | None) -> list[str]:
    opts = [f"gnw-{profile.model}",
            f"internal={profile.internal}",
            f"external={profile.external}",
            f"overlay={session.overlay}",
            f"bank1-overlay={session.bank1_overlay}",
            f"battery={session.battery}",
            f"usb-power={'on' if session.usb_power else 'off'}",
            f"battery-life-min={session.battery_life_min}",
            f"charge-time-min={session.charge_time_min}"]
    if profile.bank2:
        opts.append(f"bank2={profile.bank2}")
    if session.bank2_overlay:
        opts.append(f"bank2-overlay={session.bank2_overlay}")
    if profile.sd_wiring:
        opts.append(f"sd-wiring={profile.sd_wiring}")
    if profile.uid:
        opts.append(f"uid={profile.uid}")
    if settings.audio:
        opts.append("audio=on")
    if settings.realtime:
        opts.append("realtime=on")
    if state_file is not None:
        opts.append(f"state-file={state_file}")
    return opts


def write_profile(dest: Path, model: str, fields: dict) -> Path:
    """Write a profile. Image paths are stored relative to the file."""
    dest = Path(dest)
    if model not in ("zelda", "mario"):
        raise ProfileError(f"model must be zelda or mario, got {model!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    ident = fields.get("id")
    if not ident and dest.is_file():
        try:
            ident = _load_file(dest).get("id")
        except ProfileError:
            ident = None
    ident = _check_id(str(ident), dest) if ident else str(uuid.uuid4())
    lines = [f"version = {PROFILE_VERSION}", f'id = "{ident}"',
             f'model = "{model}"']
    for key in ("internal", "external", "bank2", "sdcard", "sd-wiring", "uid"):
        value = fields.get(key)
        if not value:
            continue
        if key in ("sd-wiring", "uid"):
            lines.append(f'{key} = "{value}"')
            continue
        path = Path(value).resolve()
        shown = Path(os.path.relpath(path, dest.resolve().parent)).as_posix()
        lines.append(f'{key} = "{shown}"')
    text = "\n".join(lines) + "\n"
    if not dest.is_file() or dest.read_text() != text:
        dest.write_text(text)
    return dest


def profile_id(path: Path) -> str:
    """Read the profile id without requiring the image files to exist."""
    path = Path(path)
    data = _load_file(path if path.is_file() else path.resolve())
    if not data.get("id"):
        raise ProfileError(f"{path}: missing id")
    return _check_id(str(data["id"]), path)


def seed_session_files(profile_path: Path, copies: dict[str, Path],
                      sessions: Path = SESSIONS) -> None:
    """Copy old save files into the session directory when those names are absent.

    `copies` maps a file name inside the session directory (flash.bin,
    bank1.bin, bank2.bin) to the previous overlay. Existing session files
    are left alone, so this only matters the first time a script moves
    off the old overlay path.
    """
    directory = session_directory(profile_id(Path(profile_path)), sessions)
    for name, source in copies.items():
        source = Path(source)
        dest = directory / name
        if dest.is_file() or not source.is_file():
            continue
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)


def main(argv: list[str] | None = None) -> int:
    import sys
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(args) >= 2 and args[0] == "session-dir":
            print(session_directory(profile_id(Path(args[1]))))
            return 0
        if len(args) >= 2 and args[0] == "paths":
            import shlex
            profile = load_profile(Path(args[1]))
            print(f"MODEL={shlex.quote(profile.model)}")
            print(f"INTERNAL={shlex.quote(str(profile.internal))}")
            print(f"EXTERNAL={shlex.quote(str(profile.external))}")
            return 0
        if len(args) >= 3 and args[0] == "write":
            fields = {}
            for item in args[3:]:
                key, value = item.split("=", 1)
                fields[key] = value
            write_profile(Path(args[1]), args[2], fields)
            return 0
        if len(args) >= 2 and args[0] == "seed":
            copies = {}
            for item in args[2:]:
                name, source = item.split("=", 1)
                copies[name] = Path(source)
            seed_session_files(Path(args[1]), copies)
            return 0
    except (ProfileError, ValueError) as exc:
        print(f"gnw: {exc}", file=sys.stderr)
        return 1
    print("usage: python -m harness.profile session-dir FILE.gnw.toml\n"
          "       python -m harness.profile write FILE.gnw.toml zelda|mario "
          "internal=... external=... [bank2=...] [sdcard=...] [sd-wiring=...]\n"
          "       python -m harness.profile seed FILE.gnw.toml "
          "flash.bin=OLD ...", file=sys.stderr)
    return 2


def qemu_argv(qemu: Path, profile: Profile, session: Session, settings: Settings,
              extra: list[str] | None = None, *,
              display: str | None = None) -> list[str]:
    argv = [str(qemu), "-M", ",".join(machine_options(
                profile, session, settings, state_file=session.state_file))]
    if settings.realtime:
        argv += ["-icount", "shift=2,sleep=off"]
    if session.sdcard:
        argv += ["-drive", f"if=sd,format=raw,file={session.sdcard}"]
    if session.rtc == "host":
        argv += ["-rtc", "base=localtime"]
    else:
        argv += ["-rtc", f"base={session.rtc},clock=vm"]
    argv += ["-display", display if display is not None else settings.display]
    argv += extra or []
    return argv


if __name__ == "__main__":
    import sys
    sys.exit(main())
