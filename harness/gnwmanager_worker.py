"""Actual GnW API worker; lifetime is bounded by harness.gnwmanager's parent."""
import contextlib
import hashlib
import importlib.resources
import json
from pathlib import Path
import random
import socket
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


def observe_application(gnw, parameters):
    """Observe startup inside the supervised process's hard Flash deadline."""
    from test_gwemu_desktop import Native
    from test_gwemu_cold_firmware import wait_for_firmware

    # A separate QMP connection permits key events and screenshots while the
    # parent owns the original QMP/QTest handles and the native lifecycle.
    observer = Native.__new__(Native)
    observer.serial = 0
    observer.read32 = gnw.read_uint32
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(3)
        connection.connect(parameters["qmpPath"])
        observer.qmp = connection
        with connection.makefile("rb") as stream:
            observer.stream = stream
            assert "QMP" in json.loads(stream.readline())
            observer.command("qmp_capabilities")
            print("application observation", file=sys.stderr, flush=True)
            return wait_for_firmware(observer, Path(parameters["screen"]), parameters["retrogo"])


def application_observation(backend, gnw, parameters):
    backend.reset_and_halt()
    backend.resume()
    return observe_application(gnw, parameters)


def flash_acceptance(backend, gnw, parameters):
    """Exercise real mailbox HASH/Flash; never fabricate firmware responses."""
    gnw.start_gnwmanager()
    gnw.wait_for_idle(timeout=5)
    capacity = gnw.external_flash_size
    assert capacity == parameters["capacity"]
    assert gnw.external_flash_block_size == 4096
    paths = {int(bank): Path(path) for bank, path in parameters["paths"].items()}
    originals = {bank: path.read_bytes() for bank, path in paths.items()}
    original_hashes = {bank: hashlib.sha256(data).hexdigest() for bank, data in originals.items()}
    addresses = {0: 0x90000000, 1: 0x08000000, 2: 0x08100000}
    def read(bank, offset, size):
        return gnw.read_memory(addresses[bank] + offset, size)
    def reject(call):
        counter = gnw.context_counter
        ready = [gnw.read_uint32(context["ready"]) for context in gnw.contexts]
        try:
            call()
        except ValueError:
            pass
        else:
            raise AssertionError("invalid Flash range accepted")
        assert gnw.context_counter == counter
        assert [gnw.read_uint32(context["ready"]) for context in gnw.contexts] == ready
    rejected = 0
    for bank in (0, 1, 2):
        cap, block = (capacity, 4096) if bank == 0 else (256 << 10, 8192)
        for offset, size in [(-block, block), (cap, block), (cap + block, block),
                             (cap - block, block * 2)]:
            for operation in ("program", "flash", "erase"):
                reject(lambda op=operation, b=bank, o=offset, s=size:
                       gnw.erase(b, o, s, blocking=False) if op == "erase" else
                       getattr(gnw, op)(b, o, b"x" * s))
                rejected += 1
        for operation in ("flash", "erase"):
            reject(lambda op=operation, b=bank, c=cap, k=block:
                   gnw.erase(b, c - k, k + 1) if op == "erase" else
                   gnw.flash(b, c - k, b"x" * (k + 1)))
            rejected += 1
        gnw.program(bank, 0, b"")
    for offset, size in [(-4096, 4096), (0, -1), (0, 0), (capacity, 1),
                         (capacity - 4096, 4097)]:
        reject(lambda o=offset, s=size: gnw.read_hashes(o, s))
        rejected += 1
    reject(lambda: gnw.program(0, 0, b"x" * ((256 << 10) + 1)))
    rejected += 1
    for bank in (1, 2):
        reject(lambda b=bank: gnw.program(b, 0, b"x" * 8191))
        rejected += 1
    assert {bank: hashlib.sha256(path.read_bytes()).hexdigest()
            for bank, path in paths.items()} == original_hashes
    whole_chip = []
    if not parameters.get("restore"):
        for bank in (0, 1, 2):
            block = 4096 if bank == 0 else 8192
            gnw.program(bank, 0, b"\x12" * block)
            gnw.erase(bank, 0, 0, whole_chip=True)
            assert read(bank, 0, block) == b"\xff" * block
            if bank == 0:
                expected = hashlib.sha256(b"\xff" * (256 << 10)).digest()
                assert gnw.read_hashes(0, capacity) == [expected] * (capacity // (256 << 10))
            else:
                assert read(bank, 0, 256 << 10) == b"\xff" * (256 << 10)
            whole_chip.append(bank)
    observations = []
    changed = []
    for bank in (0, 1, 2):
        cap, block = (capacity, 4096) if bank == 0 else (256 << 10, 8192)
        offset = cap - block
        changed.append((bank, offset, originals[bank][offset:offset + block]))
        for compressed in (False, True):
            data = bytes([0x31 + bank + compressed]) * block
            gnw.erase(bank, offset, block - 1)  # Documented rounded erase contract.
            assert read(bank, offset, block) == b"\xff" * block
            gnw.program(bank, offset, data, erase=False, compress=compressed)
            assert read(bank, offset, block) == data
            if bank == 0:
                assert gnw.read_hashes(offset, block) == [hashlib.sha256(data).digest()]
            observations.append({"bank": bank, "offset": offset, "size": block,
                                 "compressed": compressed, "sha256": hashlib.sha256(data).hexdigest()})
    for index, data in enumerate((b"gwemu-RAM-context" * (270336 // 17 + 1),
                                  random.Random(20261112).randbytes(270336))):
        data = data[:270336]
        offset = 0x10000 if index == 0 else 0x80000
        changed.append((0, offset, originals[0][offset:offset + len(data)]))
        before = gnw.context_counter
        gnw.flash(0, offset, data)
        assert gnw.context_counter - before >= 3  # HASH plus multiple program contexts
        assert read(0, offset, len(data)) == data
        hashes = [hashlib.sha256(data[i:i + (256 << 10)]).digest()
                  for i in range(0, len(data), 256 << 10)]
        assert gnw.read_hashes(offset, len(data)) == hashes
        observations.append({"bank": 0, "offset": offset, "size": len(data),
                             "compressible": index == 0, "sha256": hashlib.sha256(data).hexdigest()})
    if parameters.get("restore"):
        for bank, offset, data in changed:
            gnw.flash(bank, offset, data)
            assert read(bank, offset, len(data)) == data
        assert {bank: hashlib.sha256(path.read_bytes()).hexdigest()
                for bank, path in paths.items()} == original_hashes
    # These are actual firmware/HAL values, not success injected by the host.
    result = {"status": gnw._get_status(), "capacity": capacity, "eraseBytes": 4096,
              "rejectedBeforeSubmission": rejected, "observations": observations,
              "timestampMailbox": gnw.read_uint32("utc_timestamp"), "wholeChipBanks": whole_chip,
              "rtcTr": gnw.read_uint32(0x58004000), "rtcDr": gnw.read_uint32(0x58004004),
              "ltdcEnabled": bool(gnw.read_uint32(0x50001018) & 1),
              "framebufferSha256": hashlib.sha256(gnw.read_memory("framebuffer")).hexdigest(),
              "copyHashes": {str(bank): hashlib.sha256(path.read_bytes()).hexdigest()
                             for bank, path in paths.items()}, "restored": bool(parameters.get("restore"))}
    if parameters.get("restore"):
        from gnwmanager.cli._start import start
        start(0x08000000, halt=True, gnw=gnw)
        result["resetLtdcDisabled"] = not bool(gnw.read_uint32(0x50001018) & 1)
        result["appPc"] = backend.read_register("pc")
        backend.resume()
        result["application"] = observe_application(gnw, parameters)
    return result


def verify_persistence(_backend, gnw, parameters):
    gnw.start_gnwmanager()
    gnw.wait_for_idle(timeout=5)
    addresses = {0: 0x90000000, 1: 0x08000000, 2: 0x08100000}
    for item in parameters["observations"]:
        data = gnw.read_memory(addresses[item["bank"]] + item["offset"], item["size"])
        assert hashlib.sha256(data).hexdigest() == item["sha256"]
    return {"status": gnw._get_status(), "persistedRegions": len(parameters["observations"])}


def sd_acceptance(_backend, gnw, parameters):
    """Use actual file APIs; independent FAT verification is done after exit."""
    from gnwmanager.gnw import DataError

    gnw.start_gnwmanager()
    gnw.wait_for_idle(timeout=5)
    phase = parameters["phase"]
    listing = gnw.sd_list_dir("/")
    try:
        gnw.sd_list_dir("/gwemu-manager-nonexistent-directory")
    except DataError as error:
        missing_error = str(error)
        assert missing_error == "BAD_SD_DIR"
    else:
        raise AssertionError("missing SD directory was reported as a successful listing")
    assert gnw.sd_list_dir("/") == listing  # Release/IDLE after error is recoverable.
    files = []
    for host_path in parameters["payloads"]:
        path = Path(host_path)
        data = path.read_bytes()
        target = "/" + path.name
        if phase == "write":
            before = gnw.context_counter
            gnw.sd_write_file(target, data)
            contexts = gnw.context_counter - before
            assert contexts >= (len(data) + (256 << 10) - 1) // (256 << 10)
        else:
            contexts = 0
        if phase == "delete":
            gnw.sd_unlink(target)
            assert path.name.lower() not in gnw.sd_list_dir("/").lower()
            readback_hash = None
        else:
            assert path.name.lower() in gnw.sd_list_dir("/").lower()
            actual = gnw.sd_read_file(target)
            assert actual == data, f"SD readback differs for {target}"
            readback_hash = hashlib.sha256(actual).hexdigest()
        files.append({"name": target, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                      "readbackSha256": readback_hash, "writeContexts": contexts})
    return {"phase": phase, "status": gnw._get_status(), "missingDirectoryError": missing_error,
            "files": files, "directory": gnw.sd_list_dir("/")}


def sd_no_card(_backend, gnw, _parameters):
    from gnwmanager.gnw import DataError

    gnw.start_gnwmanager()
    try:
        gnw.sd_list_dir("/")
    except DataError as error:
        assert str(error) == "BAD_SD_FS_MOUNT"
        assert gnw._get_status() == "IDLE"
        return {"error": str(error), "statusAfterCleanup": "IDLE"}
    raise AssertionError("no-card mount failure was returned as a successful empty directory")


OPERATIONS = {"baseline": baseline, "stack-selection": stack_selection, "unpowered": unpowered,
              "flash": flash_acceptance, "verify-persistence": verify_persistence,
              "sd": sd_acceptance, "sd-no-card": sd_no_card,
              "application-observation": application_observation}


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
