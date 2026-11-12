# gwemu Desktop Supply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Safely expose native battery presence, paused restoration and cold startup in isolated desktop gwemu sessions.

**Architecture:** Extend only gwemu session metadata and expose explicit execution/power substate while preserving loaded-runtime lifecycle. Serialize device actions against runtime identity and shutdown; confirm asynchronous cold reset through QMP RESET plus a command barrier.

**Tech Stack:** TypeScript, Zod, Electron/React, QMP, Vitest, Playwright, pinned native gwemu.

## Task 1: Session and backend contracts

Files: `desktop/src/core/{schemas,session-store,gwemu-command,kernel-backend,paths}.ts`; tests `desktop/tests/unit/{gwemu-command,kernel-paths}.test.ts` and new `gwemu-supply.test.ts`.

- [x] Write meaningful failing tests: gwemu old session defaults connected, absent roundtrip, legacy metadata has no presence, strict malformed native snapshots rejected, supply args and fixed supply binary. Run `cd desktop && npm test -- tests/unit/gwemu-supply.test.ts tests/unit/gwemu-command.test.ts tests/unit/kernel-paths.test.ts`; verify expected assertions fail before production edits.
- [x] Add `gwemuSessionSchema = sessionSchema.extend({batteryPresent:z.boolean().default(true)})`; explicit kernel prepare/save path, optional Session presence for legacy callers, strict gwemu native power snapshot schema with required presence. Keep exitStateSchema unchanged.
- [x] Backend readPower/readExecution query without stop, presence/powered preflight via no-board `-M none -S` QMP qom-list-properties typename=gnw-h7b0-machine (read-only powered absent from help), guaranteed child/socket cleanup; async cold-reset helper subscribing before HMP and cleaning timeout/disconnect listeners. Require host-ui RESET and accepted HMP response; issue query-status after event before returning. Test delayed/wrong-reason RESET, timeout/disconnect and no early cont. Snapshot stop then strict readback; save only exit0 and valid presence.
- [x] Map presence startup argument and switch desktop fixed path/test helpers to gwemu-supply. Rerun targeted tests and typecheck.

## Task 2: Runtime lifecycle and device actions

Files: `desktop/src/core/session-controller.ts`, `desktop/src/shared/contracts.ts`; tests `desktop/tests/integration/gwemu-controller.test.ts` and new integration supply test.

- [x] Write failing real-native tests with temporary synthetic looping ROM/session and QTest only in test arguments. Assert source memory unchanged, pause clears held input, redundant source preserves running, loss clears volatile markers, restoration paused, cold-cycle resets marker before execution, off close/reopen without cont/frame wait, strict presence snapshot failure and runtime-bound queued stop/switch behavior.
- [x] Implement execution/devicePower/deviceOperation state and captured-runtime serialized actions. Release/flush running input before mutation; guard input during queued work/off/paused. Read state after operations and failures. Never cont/publish for stopping or replaced runtime.
- [x] Startup read native supply: skip cont/frame wait when unpowered; otherwise existing startup. Shutdown drain device work before release/snapshot, no invalid paused input. Preserve legacy state operations.
- [x] Run `GWEMU_DESKTOP_BINARY=../build/gwemu-supply/qemu-system-arm npm test -- tests/integration/gwemu-controller.test.ts tests/integration/gwemu-supply-controller.test.ts` and verify all scenarios.

## Task 3: Menus, renderer, hotkeys

Files: `desktop/src/main/{menu,index}.ts`, `desktop/src/shared/{controls,locale}.ts`, `desktop/src/renderer/App.tsx`, appropriate stylesheet; unit menu tests and `desktop/tests/e2e/gwemu-supply.spec.ts`.

- [x] Add failing menu tests for gwemu-only battery/USB checkboxes and correct pause/resume/cold enabled states; ensure ordinary/clock paths consistent and legacy menu unchanged. Add new action definitions with no default bindings.
- [x] Expose menu actions through existing controller error handling and observedActivity tracking, update checks/enabled after native reads, retain hotkey routing while off. Reset/quarantine ControlRouter plus publish input epoch at device-operation entry; test held turbo requires fresh release/press. Renderer disables chassis but leaves supply hotkeys usable; localized paused/unpowered overlay covers old frame when off. Unknown readback disables input/resume/cold until a successful refresh.
- [x] Add real Electron isolated Zelda test: held key cleared, USB redundant supply, last-source loss/paused restoration, explicit continue, cold RESET, close/reopen absence then recovery and rendering. Original source hashes finally verified. Build before test; run GUI with required approval.

## Task 4: Verification and local delivery

- [x] Run `npm run typecheck`, full desktop tests with explicit GWEMU_BINARY/GWEMU_DESKTOP_BINARY supply artifact, `npm run build`; run gwemu preview/supply and legacy automation/main-window E2E. Inspect exact results and no skips for new acceptance.
- [x] Independent spec compliance then quality review via readable tasks/results under ignored out/. Address all material findings and rerun affected checks.
- [x] Record report in `docs/research/2026-11-12-gwemu-desktop-supply.md`, update `docs/desktop/gwemu-migration.md` with tested boundary/evidence. Complete plan checkboxes only after evidence.
- [x] Local parent commit on feat/gwemu-migration. Leave `.superpowers/`, original images and product data untouched; do not push/merge parent or archive repositories.

## Final evidence

All tasks completed in the existing isolated feat/gwemu-migration workspace. Final supply artifact: eabbd8c, SHA256 dc062a2679cc26a54f57737d5b8444dc270229c908330da32f9ece478b8ba4e8. Root verification: 162 tests/42 files, typecheck/build, 5 real Electron cases passed with no skips. Spec and quality reviews APPROVED after a real-native startup cancellation race was fixed with RED/GREEN regression. Evidence and boundaries: docs/research/2026-11-12-gwemu-desktop-supply.md. Parent delivery remains local-only; default legacy and native source unchanged.
