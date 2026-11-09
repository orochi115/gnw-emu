# Desktop clock and chassis polish

**Goal:** Tighten the photographic view, restore SELECT/START mappings, make D-pad feedback clear, and implement the approved desktop clock mode.

**Architecture:** Keep one BrowserWindow, renderer, Canvas, display port and QEMU session alive. Create the window frameless with a compact custom title bar in normal mode; hide it in clock mode. This avoids platform-specific frame toggling and display reconnection. Main owns window mode, geometry and focus gating. Clock mode is session-only and never changes firmware state: TIME remains manual.

**Tech stack:** Electron, React/TypeScript, Pino, Playwright, offline Pillow asset generation.

## Design and acceptance

- Normal view removes artwork margins/shadow and fits content height to the selected artwork when loading a model or enabling its frame. Arbitrary user resize continues aspect-preserving containment. LCD is always original QEMU 320×240, 4:3, on both devices.
- Normal custom title bar provides native-menu access, minimize, maximize/restore and close. Closing uses existing save/shutdown path.
- Clock is a 480px wide, proportionate, frameless always-on-top view. Hide native menu bar and title bar; drag unoccupied chassis space. Small hover/focus controls return to normal or close. Context menu also provides return and quit. Disable file actions while compact; return before opening/editing ROM.
- Entering releases input, saves normal bounds/maximized/on-top state, and exits fullscreen/maximized layout before shrinking. Leaving restores that geometry and previous on-top value. Preserve runtime ID, process, canvas and port. Do not inject TIME, mute, pause or reset firmware. On runtime termination leave compact mode so errors remain accessible.
- Main accepts input down only when focused and unblocked; accepts valid up events for cleanup. Blur releases all sources. Renderer clears local sources on reset.
- Gameplay Tab=SELECT and Enter=START even when a chassis control has focus. Dialogs keep native navigation. Space can still activate an explicitly focused chassis button; no new game-navigation shortcut.
- D-pad uses a stronger warm face tint and bright inner rim for each independent direction, preserving the center and photographed texture.
- `view.clock`, `window.menu/minimize/maximize/close/normal` stable controls, and `ui.inspect.window` mode/onTop/contentBounds support automation. Pino records mode and focus transitions without frame/pointermove spam. Localize new controls.

## Execution

- [x] Add and run failing real Electron tests for restored Tab/Enter mappings, no artwork margin, compact mode round trip, frame continuity and unfocused IPC rejection.
  Files: `desktop/tests/e2e/chassis.spec.ts`. Run `npm run test:e2e -- tests/e2e/chassis.spec.ts` after build; expect missing mode/mapping failure.
- [x] Add isolated window-mode host in `desktop/src/main/window-mode.ts`, integrate into main/menu/preload/contracts/UiDriver. Own geometry, mode and focused state; main is the authority for IPC. Avoid changes to display transport or backend.
- [x] Implement `WindowChrome.tsx`, layout adjustment and keyboard corrections in renderer; strengthen sprites in `tools/prepare_chassis.py` and regenerate. View previews and actual runtime screenshots.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, targeted and full ordinary `npm run test:e2e`; inspect actual result and fix failures.
- [x] Update `docs/desktop/chassis.md`, automation documentation and validation record. Build app directory and run existing package smoke. Commit locally; no merge/push.

Review follow-up: disable native Zoom while compact; unmaximize before bounds restoration; recheck runtime health after fullscreen exit and bound its wait. Regression tests reproduced the former Zoom and runtime-race failures. Package validation recorded separately in docs/desktop/validation.md.

Final evidence: typecheck/build/package successful; 41 unit/integration tests, 7 ordinary E2E, 1 explicit directory-package smoke passed. Actual macOS maximize/fullscreen transitions and previously-on-top restoration also passed.
