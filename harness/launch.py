"""Window launch from a ROM profile or the stock firmware name.

    python -m harness.launch zelda [qemu args...]
    python -m harness.launch path/to/machine.gnw.toml [qemu args...]

`zelda` and `mario` load profiles/zelda.gnw.toml and profiles/mario.gnw.toml.
A profile selects images and a session. settings.toml is created on a
window run when it is missing.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .profile import (ROOT, SETTINGS_PATH, ProfileError, apply_env,
                      load_settings, load_profile, prepare_session, qemu_argv,
                      read_state_file, remember_profile, save_runtime_state)

QEMU = ROOT / "build" / "qemu-system-arm"


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print("usage: python -m harness.launch zelda|mario|FILE.gnw.toml "
              "[qemu args...]", file=sys.stderr)
        return 2 if not args else 0
    target, extra = args[0], args[1:]
    try:
        settings = load_settings(SETTINGS_PATH, write=True)
        if os.environ.get("DISPLAY_BACKEND"):
            settings.display = os.environ["DISPLAY_BACKEND"]
        if target in ("zelda", "mario"):
            target = str(ROOT / "profiles" / f"{target}.gnw.toml")
        profile = load_profile(Path(target))
        session = prepare_session(profile)
        session, settings = apply_env(session, settings)
        remember_profile(settings, profile.path)
        command = qemu_argv(QEMU, profile, session, settings, extra)
    except (ProfileError, ValueError) as exc:
        print(f"gnw: {exc}", file=sys.stderr)
        return 1
    (ROOT / "out").mkdir(parents=True, exist_ok=True)
    if not QEMU.is_file():
        print(f"gnw: qemu not built: {QEMU}", file=sys.stderr)
        return 1
    status = subprocess.call(command)
    if session is not None:
        state = read_state_file(session.state_file)
        if state is not None:
            save_runtime_state(session, *state)
            session.state_file.unlink(missing_ok=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
