# gwemu deterministic cold-cycle implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task; use test-driven-development and verification-before-completion. Review this plan and the final patch independently.

**Goal:** Make the existing native `gnw-cold-cycle` deterministic after firmware execution and repeated requests, as a prerequisite for migration stage one's cold-start acceptance.

**Architecture:** Keep upstream's in-process cold cycle, SRAM clearing and delayed POWER press. Capture the ITCM boot seed at the initial reset's exit phase, after generic-loader/ROM reset holds but before guest execution. Clear TAMP backup registers because this command claims full power removal. Leave existing direct volatile-memory writes unchanged unless a failing TCG regression establishes the need for cache invalidation. Do not introduce battery presence or CPU supply gating in this batch.

**Tech Stack:** QEMU reset phases/timers/address spaces, Python pytest/QTest/QMP, optional local firmware copies.

## Files and responsibilities

- Native `hw/arm/gnw_h7b0_soc.c`: seed capture and backup-domain clearing.
- Native `include/hw/arm/gnw_h7b0_soc.h`: clarify seed lifetime.
- Native `docs/GNW_EMU_FORK.md`: patch behavior and limits.
- Parent `tests/test_gwemu_power.py`: regression coverage for initial loader data, guest mutations, repeated pulses and backup-register reset distinction.
- Parent `tests/test_gwemu_cold_firmware.py`: opt-in repeated real-firmware rendering/Retro-Go bank2 handoff using source copies and source hash checks.
- Parent `docs/research/2026-11-12-gwemu-cold-cycle.md`: exact evidence and remaining limitations; migration docs refer to it.

## Task 1: Expose cold-cycle defects before production edits

- [x] Add tests that load a small ITCM image via `-device loader,file=...,addr=0,force-raw=on`, mutate both loaded and unloaded spans after startup, then require original loaded bytes and zeroed remainder across two cycles. Run against `build/gwemu-softspi/qemu-system-arm`; require a failure on the mutated unloaded span.
- [x] Plant TAMP BKP0R/BKP31R markers at `0x58004500`/`0x5800457c`. Require `system_reset` to retain them and `gnw-cold-cycle` to clear them. Require failure before the patch.
- [x] Run a cycle, advance virtual time 800 ms (POWER down), request another cycle, advance 100 ms before the old release then 650 ms past it to the new press and 200 ms to release. Require POWER to be released immediately by the second cycle. Characterize before the patch; it passes, so retain without timer changes.

Run: `GWEMU_BINARY="$PWD/build/gwemu-softspi/qemu-system-arm" .venv/bin/python -m pytest tests/test_gwemu_power.py -k 'cold' -v`.

## Task 2: Repair native lifecycle

- [x] Capture `cold_itcm_seed` once in `gnw_h7b0_soc_reset_exit`, before handoff scheduling. Remove capture from the cold-cycle command. Verify reset phase ordering against QEMU resettable/ROM loader code and the loaded-image test.
- [x] Repeated-pulse test passed on the old binary: GPIO reset already releases POWER and timer_mod reschedules the press. Do not change this behavior without a failing case.
- [x] Only if a failing executable-in-RAM TCG test demonstrates stale translations, replace direct RAM writes with `address_space_set(&address_space_memory, BASE, 0, SIZE, MEMTXATTRS_UNSPECIFIED)` and restore ITCM with `address_space_write`. Check all bank sizes against their MemoryRegion sizes; keep Flash/UID/option bytes unchanged.
- [x] Call `gnw_h7b0_tamp_backup_domain_reset(&s->tamp)` for full removal. Retain current RTC reset convention: configured epoch/host initialization, not verified physical VBAT loss semantics.
- [x] `ninja -C build/gwemu-fork qemu-system-arm`, run power/desktop/baseline/software-SPI native suites; require all pass.
- [x] Do not change the RAM write path without a small failing TCG executable-in-ITCM test. No such failing case was established in this batch; leave the write path unchanged and record the follow-up.

## Task 3: Real firmware and review

- [x] Add opt-in `GNW_FIRMWARE_COLD_TEST=1` tests for Mario/Zelda OFW and Flash/SD Retro-Go. Reuse existing copied-image conventions, perform two cycles after running, require fresh rendering and bank2 handoff where applicable; persist screenshots/observations under ignored `out/gwemu-cold-cycle/`. Hash originals before and after. Avoid interpreting rendering alone as Retro-Go handoff.
- [x] Run real firmware tests against the incremental binary; inspect screenshots. This does not accept RDP protection transitions, gnwmanager unlock or true battery removal.
- [x] Request independent code review against native `040b7e2` and parent `be7d75c`; fix material findings and rerun affected checks.

## Task 4: Reproducible delivery

- [x] Update native fork notes and commit verified native source. Build clean `GWEMU_BUILD_DIR=build/gwemu-cold-cycle sh scripts/build_gwemu.sh`, record manifest and SHA256.
- [x] Run the four native suites and cold real-firmware acceptance against that exact clean binary, plus desktop `npm test` using explicit binary overrides. Native behavior changed only; no desktop binary default change in this batch.
- [x] Write evidence report and remaining scope. Push authorized native branch and verify remote SHA. Commit parent tests/docs/submodule pointer locally, leaving `.superpowers/` untouched and main unmerged/unpushed.

## Completion boundary

This is a native cold-cycle reliability batch. It does not add a desktop cold-start control, battery-connected property, off-state CPU enforcement, Flash savestate rollback, management endpoints or fork retirement. RTC's existing reset convention and delayed press are emulator approximations. Full migration remains open.

## Delivery evidence

Native commit `07baa2c1e72e85c06992a1d6486fd67168822911`; clean build `build/gwemu-cold-cycle`, sourceDirty=false. Exact artifact: 41 native tests, 145 desktop tests/39 files, 4 copied-ROM cold tests (two cycles each), source hashes unchanged. Final review APPROVED. RAM write path and pulse timing were intentionally kept unchanged; conditional cache work deferred pending a failing TCG case. See `docs/research/2026-11-12-gwemu-cold-cycle.md`.
