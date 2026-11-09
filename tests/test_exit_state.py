import json
from test_display_transport import start, finish


def test_exit_snapshot_is_json_and_contains_actual_device_state(tmp_path):
    path = tmp_path / "state.json"
    proc, qmp = start(tmp_path, f",state-file={path},battery=43,usb-power=on")
    finish(proc, qmp)
    assert json.loads(path.read_text()) == {"formatVersion": 1, "battery": 43, "usbPower": True}
