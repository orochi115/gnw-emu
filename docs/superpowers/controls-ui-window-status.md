# Controls UI handoff

Implemented in owned controls components + locale + helper unit test. No commit.

- `ControlsDialogProps` now supports `page?: "buttons" | "hotkeys"` (default buttons) and `embedded?: boolean` (default false). Embedded mode renders a full-window section, no `showModal()`, preserving `data-ui="controls.dialog"` and existing props.
- No internal page tabs, model selector, default turbo toolbar or developer descriptions. Supplied model remains authoritative. Device button is in the shared top-right header on both pages.
- `normalizeControlsDraft` makes a detached draft, converting legacy `turbo: "default"` to saved `defaultTurboHz`; persisted schema untouched. UI turbo radio segments/submenu only show Normal / 6 / 10 / 15.
- Details open idle. Click `controls.capture` to record. Keyboard Tab/Esc are direct recordable inputs while listening. `controls.capture.cancel` visibly stops recording and restores pre-recording current/preview; ordinary capture ends after input, chords end after release-all, source choices still supported. Successful recording stops listening and retains full detail for turbo/delete/conflicts. `controls.capture` has `aria-pressed` for testable state.
- Keyboard-only modifiers shown only for an actual keyboard hotkey binding; gamepad button chords have no modifier controls.
- Scoped CSS fixes inherited 40px button height, oversized checkbox/range inputs, device popover positioning. No global app stylesheet edited. Recording text now one concise line; turbo prose removed.
- Physical modifier key icons/description localize side and platform: Chinese `左⌘` / `左 Command`, English `L⌘` / `Left Command`, Windows `右Win` / `右 Windows`. Navigation keys retain short readable names.

Verification:
- Helper tests failed for unresolved legacy turbo and raw modifier labels before implementation; now 3 pass (immutable draft, platform/directional labels, navigation key labels).
- Full `npm test`: 30 files / 108 tests passed (includes root's concurrent tests).
- `npm run typecheck` currently has only root-owned `src/main/control-window.ts:22` Electron move/resize overload error; no UI errors.
- Owned files formatted with Prettier.

Root still needs actual Electron capture/layout E2E checks. Existing ControlsDiagram minimum zoom remains .75; intended native buttons window should have roughly >=945px body width and >=555px body height to avoid scrolling; smaller screens still scroll safely.
