"""Actual GnW API worker; lifetime is bounded by harness.gnwmanager's parent."""
import contextlib
import importlib.resources
import json
import sys
import time

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
    registers["xpsr"] = backend.read_register("xpsr")
    xpsr = registers["xpsr"]
    try:
        backend.write_register("xpsr", xpsr ^ (1 << 31))
        assert backend.read_register("xpsr") == xpsr ^ (1 << 31)
    finally:
        backend.write_register("xpsr", xpsr)
    assert backend.read_register("xpsr") == xpsr
    backend.write_register("msp", registers["msp"])
    assert backend.read_register("sp") == registers["msp"]
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
            "xpsrRoundtrip": "restored", "mspSelection": "reset MSP",
            "status": gnw._get_status(), "flashBytes": gnw.external_flash_size,
            "eraseBytes": gnw.external_flash_block_size}


def stack_selection(backend, _gnw, _parameters):
    from gnwmanager.ocdbackend.gdb_backend import GDBError

    backend.reset_and_halt()
    original_msp = backend.read_register("msp")
    # Real Thumb guest instructions: LDR r0,=0x20008000; MSR PSP,r0;
    # MOVS r0,#2; MSR CONTROL,r0; ISB; B . . ARM GCC10 assembler evidence
    # resides in out/gnwmanager-ram/task2-psp.{S,o,bin}.
    code = bytes.fromhex("044880f30988022080f31488bff36f8ffee7000000800020")
    backend.write_memory(0x24020000, code)
    backend.write_register("pc", 0x24020001)
    backend.resume()
    time.sleep(.03)
    backend.halt()
    selected = {name: backend.read_register(name) for name in ("sp", "msp", "psp", "control")}
    assert selected["control"] & 2
    assert selected["sp"] == selected["psp"] == 0x20008000
    assert selected["msp"] == original_msp != selected["sp"]
    try:
        backend.write_register("msp", 0x2000F000)
    except GDBError as error:
        assert "inactive MSP" in str(error)
    else:
        raise AssertionError("inactive MSP write was accepted")
    assert backend.read_register("sp") == selected["sp"]
    assert backend.read_register("msp") == original_msp
    backend.reset_and_halt()
    assert backend.read_register("msp") == backend.read_register("sp")
    return {"selected": selected, "inactiveMspWrite": "rejected", "resetRestoredMsp": True}


def unpowered(backend, _gnw, _parameters):
    backend.reset_and_halt()
    # ADDS r0,#1; B back to ADDS. If the supply gate were bypassed, r0
    # advances even though this loop's sampled PC could remain unchanged.
    backend.write_memory(0x24020000, bytes.fromhex("0130fde7"))
    backend.write_register("pc", 0x24020001)
    backend.write_register("r0", 0x1234)
    backend.resume()
    time.sleep(.03)
    backend.halt()
    value = backend.read_register("r0")
    assert value == 0x1234, "GDB resume executed guest instructions without supply"
    backend.reset()
    return {"counter": value, "resumeWithoutSupply": "no execution"}


OPERATIONS = {"baseline": baseline, "stack-selection": stack_selection, "unpowered": unpowered}


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
