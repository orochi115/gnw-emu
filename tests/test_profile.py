"""ROM profile, session directory and settings file. No QEMU."""
import hashlib
from pathlib import Path

import pytest

from harness.profile import (ProfileError, apply_env, load_profile,
                             load_settings, machine_options, prepare_session,
                             qemu_argv, read_state_file, save_runtime_state,
                             seed_session_files, session_directory,
                             write_profile)


def _images(tmp: Path, bank2: bool = False, sd: bool = False) -> None:
    (tmp / "bank1.bin").write_bytes(b"bank1")
    (tmp / "ext.bin").write_bytes(b"external-flash")
    if bank2:
        (tmp / "bank2.bin").write_bytes(b"bank2")
    if sd:
        (tmp / "sdcard.img").write_bytes(b"sd")


def _profile(tmp: Path, extra: str = "") -> Path:
    path = tmp / "zelda.gnw.toml"
    path.write_text(
        "version = 1\n"
        'model = "zelda"\n'
        'internal = "bank1.bin"\n'
        'external = "ext.bin"\n'
        + extra)
    return path


def test_session_dir_uses_absolute_path_hash(tmp_path: Path):
    profile = tmp_path / "zelda.gnw.toml"
    digest = hashlib.sha256(str(profile.resolve()).encode()).hexdigest()[:8]
    assert session_directory(profile, tmp_path / "sessions") == (
        tmp_path / "sessions" / f"zelda-{digest}")


def test_same_stem_in_two_directories_do_not_share_a_session(tmp_path: Path):
    a = tmp_path / "a" / "zelda.gnw.toml"
    b = tmp_path / "b" / "zelda.gnw.toml"
    assert session_directory(a) != session_directory(b)


def test_prepare_copies_images_and_leaves_the_profile_directory(tmp_path: Path):
    _images(tmp_path, bank2=True)
    profile = load_profile(_profile(tmp_path, 'bank2 = "bank2.bin"\n'))
    sessions = tmp_path / "sessions"
    session = prepare_session(profile, sessions)
    assert (session.directory / "flash.bin").read_bytes() == b"external-flash"
    assert (session.directory / "bank1.bin").read_bytes() == b"bank1"
    assert (session.directory / "bank2.bin").read_bytes() == b"bank2"
    assert list(tmp_path.glob("*.bin"))  # originals still in place
    text = (session.directory / "session.toml").read_text()
    assert 'rtc = "host"' in text
    # A second open keeps the writable copies.
    (session.directory / "flash.bin").write_bytes(b"saved")
    again = prepare_session(profile, sessions)
    assert again.overlay.read_bytes() == b"saved"


def test_no_bank2_leaves_that_overlay_empty(tmp_path: Path):
    _images(tmp_path)
    session = prepare_session(load_profile(_profile(tmp_path)), tmp_path / "s")
    assert session.bank2_overlay is None
    assert not (session.directory / "bank2.bin").exists()


def test_missing_image_and_bad_version(tmp_path: Path):
    path = _profile(tmp_path)
    with pytest.raises(ProfileError, match="not found"):
        load_profile(path)
    _images(tmp_path)
    path.write_text(path.read_text().replace("version = 1", "version = 2"))
    with pytest.raises(ProfileError, match="version"):
        load_profile(path)


def test_wiring_requires_an_sd_image(tmp_path: Path):
    _images(tmp_path)
    path = _profile(tmp_path, 'sd-wiring = "ospi"\n')
    with pytest.raises(ProfileError, match="sdcard"):
        load_profile(path)


def test_env_override_does_not_stick_until_exit_state(tmp_path: Path):
    _images(tmp_path)
    profile = load_profile(_profile(tmp_path))
    session = prepare_session(profile, tmp_path / "s")
    settings = load_settings(tmp_path / "settings.toml", write=False)
    assert not (tmp_path / "settings.toml").exists()
    launched, settings = apply_env(session, settings, {
        "BATTERY": "30", "USB_POWER": "on", "BATTERY_LIFE_MIN": "10",
        "DISPLAY_BACKEND": "none"})
    assert launched.battery == 30
    assert launched.battery_life_min == 10
    assert settings.display == "none"
    assert "battery = 100" in (session.directory / "session.toml").read_text()
    opts = ",".join(machine_options(profile, launched, settings,
                                    state_file=session.state_file))
    assert "battery=30" in opts
    assert "battery-life-min=10" in opts
    assert f"internal={profile.internal}" in opts
    (session.state_file).write_text("battery=27\nusb-power=true\n")
    save_runtime_state(session, *read_state_file(session.state_file))
    text = (session.directory / "session.toml").read_text()
    assert "battery = 27" in text
    assert "usb-power = true" in text
    assert "battery-life-min = 480" in text


def test_write_profile_stores_paths_relative_to_the_file(tmp_path: Path):
    images = tmp_path / "backup"
    images.mkdir()
    (images / "bank1.bin").write_bytes(b"b1")
    (images / "ext.bin").write_bytes(b"ext")
    dest = tmp_path / "out" / "profiles" / "full.gnw.toml"
    write_profile(dest, "zelda", {
        "internal": images / "bank1.bin",
        "external": images / "ext.bin",
    })
    text = dest.read_text()
    assert 'internal = "../../backup/bank1.bin"' in text
    loaded = load_profile(dest)
    assert loaded.internal == (images / "bank1.bin").resolve()
    old = tmp_path / "old_flash.bin"
    old.write_bytes(b"saved")
    sessions = tmp_path / "sessions"
    seed_session_files(dest, {"flash.bin": old}, sessions)
    flash = session_directory(dest, sessions) / "flash.bin"
    assert flash.read_bytes() == b"saved"
    seed_session_files(dest, {"flash.bin": tmp_path / "missing.bin"}, sessions)
    assert flash.read_bytes() == b"saved"


def test_qemu_argv_uses_settings_and_sd_drive(tmp_path: Path):
    _images(tmp_path, sd=True)
    profile = load_profile(_profile(
        tmp_path, 'sdcard = "sdcard.img"\nsd-wiring = "spi1"\n'))
    session = prepare_session(profile, tmp_path / "s")
    settings = load_settings(tmp_path / "settings.toml", write=True)
    argv = qemu_argv(Path("qemu-system-arm"), profile, session, settings,
                     ["-d", "unimp"])
    assert argv[0] == "qemu-system-arm"
    assert any(part.startswith("gnw-zelda,") for part in argv)
    assert "-drive" in argv
    assert f"file={profile.sdcard}" in argv[argv.index("-drive") + 1]
    assert settings.realtime
    assert "-icount" in argv
    assert argv[-2:] == ["-d", "unimp"]
    assert (tmp_path / "settings.toml").read_text().startswith("version = 1\n")
