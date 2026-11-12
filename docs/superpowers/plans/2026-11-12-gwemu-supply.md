# gwemu supply-presence implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans, test-driven-development, requesting-code-review, verification-before-completion. Preserve the local migration branch; do not merge or push the parent.

**Goal:** Add native battery presence and an execution gate while both battery and USB supply are absent.

**Architecture:** Extend the opt-in board power module with battery presence and derived supply availability. Synchronize VM stop on supply loss; use SoC cold-reset helpers without delayed POWER while off. A default-permissive machine run check guards central VM resume and produces protocol errors at QMP/GDB entries. Supply restoration cold-resets but never automatically resumes.

**Tech Stack:** QEMU machine/QOM/reset/runstate/GDB RSP, Python pytest/QTest/TCG, existing copied-ROM fixtures.

Spec: `docs/superpowers/specs/2026-11-12-gwemu-supply-design.md`.

## Files

- Native `hw/arm/gnw_h7b0_power.{c,h}`, `hw/arm/gnw_h7b0.c`: properties, percentage settling, ADC/PGOOD/CHG and supply transitions.
- Native `hw/arm/gnw_h7b0_soc.c`, `include/hw/arm/gnw_h7b0_soc.h`: supply latch, cold reset without synthetic POWER on loss, timer cancellation, suppress off-state handoff.
- Native `include/hw/core/boards.h`, `hw/core/machine.c`: optional default-permissive can_run callback/helper.
- Native `system/cpus.c`, `monitor/qmp-cmds.c`, `gdbstub/system.c`, shared GDB handler/internals and user-mode default helper if needed: pre-execution gate and clear protocol errors, no CPU stepping side effects after denial.
- Native `docs/GNW_EMU_FORK.md`: provenance, contract and limits.
- Parent new `tests/test_gwemu_supply.py`: native truth table, TCG counter and minimal RSP observer.
- Parent `tests/test_gwemu_cold_firmware.py`: extend reusable copied-firmware acceptance to explicit supply loss/restore mode while preserving cold-cycle mode.
- Parent plan/spec/research/migration docs: evidence and limits. Do not change desktop default binary path or schema in this batch.

## Task 1: Failing behavior tests (root)

- [x] Add property truth-table test: `/machine` battery-present is writable/default true; powered derived/readonly; four combinations and model-off compatibility.
- [x] Add absent battery charging freeze/ADC0/CHG inactive test, connected0 remains powered, setters postinit require enabled.
- [x] Add paused cold transition and initially absent supply tests. HMP cold-cycle must refuse while off.
- [x] Create tiny Cortex-M7 loop firmware that increments DTCM count and advances QEMU virtual time under real TCG. Assert changing last source to false pauses and clears count. Attempt QMP cont and HMP cont with errors; system_reset and system_wakeup cannot resume. Restore supply and require paused/zero until explicit cont.
- [x] Minimal Unix GDB RSP client checks plain c/s and vCont;c/vCont;s return E22 while off; connection remains usable for '?' and reading registers. No GDB resume/step may execute instructions. D detach returns only OK, does not run, and reconnect remains usable. After restoring supply, clear rejected-step flags so QMP continue does not single-step unexpectedly.
- [x] Add back-to-back restore/continue without query-status or sleeps and unrelated -M none default-allow smoke test. Run against clean `build/gwemu-cold-cycle/qemu-system-arm`; record missing-property failures. Do not edit production code until observed.

Run: `GWEMU_BINARY="$PWD/build/gwemu-cold-cycle/qemu-system-arm" .venv/bin/python -m pytest tests/test_gwemu_supply.py -v`.

## Task 2: Native implementation (worker)

- [x] Review exact spec, failing test results and reset/runstate code first. Existing native base is `07baa2c1e72e85c06992a1d6486fd67168822911`.
- [x] Add default-true battery_present and read-only powered; runtime setter requires enabled. Use `battery_present || usb` only when enabled, not percentage.
- [x] Settle percentage using the OLD source state before source changes; skip charge/drain when absent. ADC0/CHG false when absent; retain current PGOOD and connected scaling.
- [x] Supply falling transition: synchronous vm_stop before SRAM clearing; cancel startup/POWER timers, release POWER, clear warm fault pending, clear/reset volatile and TAMP; no synthetic POWER while off. Supply rising: cold reset and pulse, stay stopped. Both transitions synchronously execute qemu_system_reset after stopping vCPUs, completing before setter return; standard reset clears suspended intent. Initial off suppresses handoff after seed capture.
- [x] Add default-permissive can_run helper and guard before any VM runstate/event/tick changes. QMP cont emits a descriptive supply error; GDB c/s/C/vCont execution handlers emit E22 before step flags are armed; central gdb_continue stays silent for detach, which must return a single OK. Do not alter unrelated machines' normal behavior.
- [x] Build `ninja -C build/gwemu-fork qemu-system-arm`, run supply tests and existing four native suites. Preserve upstream licenses; leave source uncommitted for independent review.

## Task 3: Firmware and reviews (root)

- [x] Extend copied-ROM test to opt-in supply mode: run/render; remove battery with USB still present (no reset), then USB loss; verify paused, TAMP clear and cont rejection; restore USB and remain paused; explicit cont + TIME/Left+GAME where needed; require fresh LTDC and bank2 twice. Verify source hashes in finally.
- [x] Run four profiles on incremental binary. Inspect screenshots; record supply transitions and paused state in ignored out/gwemu-supply.
- [x] Independent spec/quality review of native core integration and parent evidence. Fix important issues, rerun affected verification only.

## Task 4: Deliver verified batch

- [x] Update native fork notes and commit. Build `GWEMU_BUILD_DIR=build/gwemu-supply sh scripts/build_gwemu.sh` from clean revision; record sourceDirty=false and artifact SHA256.
- [x] Run exact-binary supply + existing four native suites, original cold-cycle and supply copied-ROM tests, desktop npm test with both binary overrides. No TS/GUI changes means no additional GUI suite required unless integration reveals concern.
- [x] Write research report, update plan and migration docs; independent final review. Push authorized native branch, verify remote exact SHA, commit parent explicitly staged files/submodule locally. Leave pre-existing .superpowers untouched.

## Boundaries

No desktop battery switch, session persistence field, complete VMState/Flash rollback, current-session endpoint, RTC physical VBAT fidelity, RDP protection acceptance or fork retirement. Memory cache invalidation remains unchanged unless a failing executable test establishes a problem. Global QEMU virtual clock stops with VM while off; this is not always-on-domain modeling.

## Delivery evidence

Native `eabbd8cc1476722a6f8d8e981189a9aede99d917`, clean build gwemu-supply/sourceDirty=false. Exact artifact: 59 native (18 supply +41 existing), 145 desktop/39 files, 8 cold/supply copied-ROM cases passed; originals unchanged. Both wire loss/quit/reopen cases passed. Spec/quality/final reviews APPROVED. Actual CPU reset completion and timer cancellation are source-reviewed; RAM marker alone proves clear-before-execution. No true suspend entry exists on this board; standard reset clears suspended intent. Desktop schema/control/default-path integration remains next work. See supply research report.
