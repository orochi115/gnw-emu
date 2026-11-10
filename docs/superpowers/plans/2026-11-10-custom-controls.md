# Custom Controls Implementation Plan

> **For agentic workers:** Use subagent-driven-development for isolated tasks and requesting-code-review for spec and quality review. Use test-driven-development for input, matching, persistence and lifecycle behavior.

**Goal:** Implement the approved shared keyboard/gamepad mappings, turbo, hotkeys, conflict UI and settings persistence without forwarding configuration input to QEMU.

**Architecture:** Shared versioned control definitions and pure matching/conflict functions feed a main-process routing engine. Renderer reads gamepads and edits drafts; main owns isolation, dispatch, turbo and atomic persistence. Existing source-aggregating InputController and window/session lifecycles remain authoritative.

**Tech Stack:** TypeScript, React, Electron, Zod, Vitest, Playwright, existing QMP client.

Spec: `docs/superpowers/specs/2026-11-10-custom-controls-design.md`.
Worktree: `/Users/sakura/GameWatch_Zelda/gnw-emu-controls`, branch `feat/custom-controls`.
Baseline: 22 files / 70 unit tests passed before changes. Reuse installed node_modules and built QEMU via ignored symlinks; ROM profiles reference the shared workspace firmware.

## Shared interfaces

`desktop/src/shared/controls.ts` exposes:

```ts
type Modifier = 'Control' | 'Shift' | 'Alt' | 'Meta';
type InputToken = { kind: 'keyboard'; code: string } | {
  kind: 'gamepad'; device: string; control: 'button' | 'axis';
  index: number; direction?: -1 | 1;
};
interface ControlBinding {
  id: string;
  target: string; // logical ID or registered action ID
  inputs: InputToken[];
  modifiers: Modifier[];
  turbo: number | 'default' | null;
}
interface ControlsSettings {
  version: 1;
  bindings: ControlBinding[];
  defaultTurboHz: number;
  devices: Record<string, { enabled: boolean; deadzone: number }>;
}
interface ControlInputEvent {
  source: string;
  input: InputToken;
  down: boolean;
  modifiers: Modifier[];
  epoch: number;
}
```

Exports include `controlsSchema`, `defaultControls(platform?)`, `LOGICAL_BUTTONS` (id/bit), `HOTKEY_ACTIONS` (stable IDs), `isHotkeyTarget`, `inputLabel`, `findConflicts(config)` keyed by binding ID, and identity/matching helpers. Logical IDs follow chassis IDs. Hotkeys use `file.open`, `file.make`, `view.chassis`, `view.clock`, `audio.mute`, `device.batteryDown`, `device.batteryUp`, `device.usb`. Default gamepad token device `standard` matches only incoming fingerprints starting `standard:`; explicitly captured devices match exact fingerprints. Keyboard defaults retain Tab and Q.

`desktop/src/core/control-router.ts` exposes `ControlRouter(config, {button(bit, down, source), action(id), release(), flush?(): Promise<void>, failed?(error)})`, `event(ControlInputEvent)`, `setBlocked(boolean)`, `setConfig(config)`, `releaseDevice(prefix)`, `reset()`, `dispose()`, and `epoch`. Router tracks raw held inputs even when blocked; lifting isolation quarantines held sources until release. Keyboard hotkeys are exact-modifier, main-key-down triggered; gamepad chords trigger on transition to all-required-held. Output sources are per binding/device. Timers implement equal duty-cycle turbo and are canceled at every reset.

Main/preload `DesktopApi` additions: `controls(): Promise<ControlsSettings>`, `openControls(): Promise<void>`, `saveControls(config): Promise<void>`, `closeControls(): Promise<void>`, `controlInput(event): void`, `onControlsOpen(callback): unsubscribe`, `onInputEpoch(callback): unsubscribe`. Existing input.button and input.key remain compatible, but configuration and focus guards also cover their main entry points.

## Task 1 — Shared schema, defaults and conflicts

Files: create `desktop/src/shared/controls.ts`, `desktop/tests/unit/controls.test.ts`; modify `desktop/src/core/schemas.ts`, `desktop/tests/unit/settings-store.test.ts`.

- [x] Write failing tests for default migration, strict schema validation, physical code identity, standard/exact device matching, exact keyboard modifier conflict distinction, hardware-vs-modified-hotkey conflict, chord containment and ordinary/turbo same input conflict.
- [x] Run `npm test -- tests/unit/controls.test.ts tests/unit/settings-store.test.ts` and observe the missing control schema/defaults failure.
- [x] Implement helpers and bounded schema, keeping UI and Electron imports out of the shared module. Add `controls` default to existing settings schema so old settings migrate without discarding unrelated values.
- [x] Verify actual JSON save/reload and concurrent unrelated preference updates preserve controls.
- [x] Run the same tests to pass; review schema and persistence diff.

## Task 2 — Runtime routing, turbo and isolation

Files: create `desktop/src/core/control-router.ts`, `desktop/tests/unit/control-router.test.ts`.

- [x] Write failing tests with real mask aggregation callbacks and Vitest fake timers: remap, mixed sources, multiple outputs, exact hotkeys, chord edges, turbo phase, ordinary source surviving turbo release, blocked input, held-source quarantine, stale epoch and disconnect.
- [x] Run `npm test -- tests/unit/control-router.test.ts`, observe missing router behavior.
- [x] Implement router using source IDs including binding and device instance; cap internal input state, validate finite inputs, ignore repeats, avoid rearming hotkeys from unrelated events or modifier changes.
- [x] Ensure reset/config change/dispose stop timers and clear all routed output; raw neutral transitions while blocked must still allow fresh inputs later.
- [x] Implement bounded turbo dispatch: at most one asynchronous flush in flight for scheduler-generated transitions; skip elapsed turbo phases while waiting instead of appending them to the QMP promise chain. Ordinary physical taps remain ordered and uncoalesced. A flush failure stops scheduler output and reports the error; an isolation/reset generation invalidates pending callbacks.
- [x] Add and run a slow-QMP test holding the flush promise unresolved across many turbo periods; assert bounded scheduler submissions, timely final neutral state, no stale phase after releasing/isolation, and unchanged serialization of ordinary short taps.
- [x] Run tests to pass, including the slow-QMP case, before main hookup.

## Task 3 — Main integration and persistent transactions

Files: modify `desktop/src/main/index.ts`, `desktop/src/main/menu.ts`, `desktop/src/core/session-controller.ts`, `desktop/src/main/window-mode.ts`, `desktop/src/preload/index.ts`, `desktop/src/shared/contracts.ts`; add meaningful unit menu/session tests.

- [x] Add tests for configurable menu accelerators including removal, single dispatch and session flush barrier before configuration capture.
- [x] Instantiate router from saved controls. Map outputs to SessionController button sources; expose an explicit device action method and input flush barrier instead of hard-coded shortcuts bypassing the router.
- [x] Register trusted and validated control IPC. Opening enters isolation, stops turbo, releases input, awaits QMP flush, records window geometry and opens the configuration UI with a monotonically increasing epoch.
- [x] Resize configuration to a readable window within available screen geometry without changing saved game scale; close restores prior geometry and clock state as appropriate.
- [x] Save via `updateSettings(userData, { controls: controlsSchema.parse(config) })`, apply only on successful persistence, publish new epoch, then close. Failure keeps dialog/draft open and routing blocked.
- [x] Guard input.button, legacy keys, native accelerators, hotkey actions, pointer sources, stale IPC, focus and session changes. Keep raw input tracking while isolated; hold suppression after close prevents leakage.
- [x] Reuse action handlers. Display configured primary menu accelerators while avoiding duplicate native and router dispatch; no old default shortcut remains active after removal.
- [x] Run unit menu/session tests and `npm run typecheck`.

## Task 4 — Device polling and configuration UI

Files: create focused components under `desktop/src/renderer/components/controls/`, scoped stylesheet, complete original image assets, `desktop/src/renderer/hooks/useControlInput.ts`; modify `desktop/src/renderer/App.tsx`, `desktop/src/shared/locale.ts`, add capture/device pure-function tests where behavior warrants them.

- [x] Write failing tests for axis hysteresis/neutral-before-capture, device fingerprints and event generation; run them before implementation.
- [x] Implement Gamepad API polling independently from game routing. Track fingerprints and runtime instances, emit release on disconnect and suspend, use 25% entry/20% exit default thresholds, display unavailable/unidentifiable device limitations honestly.
- [x] Implement/tests for multi-source capture: if multiple interfaces report the same physical gesture, show a source choice before creating a binding. Persist participation only for distinguishable fingerprints; colliding fingerprints get runtime-instance switches marked “this connection”, never persisted indexes. Test disconnect/reconnect and collision cases.
- [x] Implement modal ordinary page matching approved v5: complete images, all 12 fixed bubbles, noncrossing outlined leaders, Mario START/SELECT without leaders, mixed icons, whole-icon pages, sticky plus and conflict markers. Add the grouped-direction shortcut to device/axis setup.
- [x] Implement single-binding details: immediate draft update, first-input stops listening, explicit re-record, delete, segmented turbo defaults/frequencies; accessible menu with turbo submenu and no dropdowns.
- [x] Implement scrollable hotkey table, grouped combination icons, per-binding modifier toggles and release-all chord recording; no hotkey turbo controls.
- [x] Use one draft for both pages and devices/default Hz. Main API save/close are authoritative; no detail confirmation beyond Done. Conflicts update after every edit and list target/page/trigger in details.
- [x] Ensure short bilingual labels, focus navigation and Esc/Tab handling during capture; internal capture data never invokes QEMU actions.
- [x] Run typecheck and capture/device tests; manually inspect two models and overflow/details/submenus.

## Task 5 — End-to-end acceptance and integration

Files: create `desktop/tests/e2e/controls.spec.ts`; update UI Driver/diagnostics where needed, docs desktop control guide and validation, plan checkboxes.

- [x] Run `npm run build` then `npm run test:e2e -- tests/e2e/controls.spec.ts` against real Electron/QEMU and temporary userData. Cover JSON persistence across restart, remapping, cross-model reuse, draft cancel, turbo, modified hotkey conflicts, capture isolation/QMP neutral, post-close held suppression and save failure.
- [x] Cover gamepad normalization with deterministic device snapshots plus real connected device inspection if hardware is available. Report separately when USB/Bluetooth hardware is not present; do not claim simulated inputs prove hardware connectivity.
- [x] Verify native accelerators remain compatible and update after remap/delete; run targeted chassis, automation and clock regression E2Es.
- [x] Stage/package the desktop app and run the configured controls through the packaged-environment acceptance path, verifying original image assets and settings loading are included.
- [x] Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`; review specification compliance and code quality, fix issues and rerun affected checks.
- [x] Commit scoped implementation and verification docs. Integrate the completed branch into the user's original repository so launched gnw-emu uses the new feature; preserve existing untracked design previews.

## Progress

- Planning/specification: approved.
- Core, renderer/device polling, main integration: complete. Independent core and final reviews resolved all reported findings.
- Verification: 28 unit files / 103 tests; typecheck/build; 13 Electron/QEMU feature and chassis/clock/form tests; directory package test with images, mapping save and real QEMU input passed.
- Native controller hardware: no connected devices exposed by Chromium; deterministic Gamepad API tests cover normalization, chords, stick/dpad and mixed keyboard sources. USB/Bluetooth hardware acceptance remains manual.
- Integration: fast-forwarded master to feature commit 17da281, rebuilt the original checkout and directory package. Original-checkout unit/type checks and all six controls E2E passed; implementation worktree cleaned up, original design previews preserved.
