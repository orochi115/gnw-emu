import subprocess
from test_display_transport import start, finish


def test_lock_is_held_by_qemu_until_exit(tmp_path):
    lock = tmp_path / "session.lock"
    first_dir = tmp_path / "first"; first_dir.mkdir()
    second_dir = tmp_path / "second"; second_dir.mkdir()
    proc, qmp = start(first_dir, f",session-lock={lock}")
    try:
        import pytest
        with pytest.raises(pytest.fail.Exception, match="[Ll]ock|occupied"):
            start(second_dir, f",session-lock={lock}")
    finally:
        finish(proc, qmp)
    again, again_qmp = start(second_dir, f",session-lock={lock}")
    finish(again, again_qmp)
