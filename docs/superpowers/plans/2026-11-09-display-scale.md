# Display Scale Implementation Plan

> Execute inline in the existing isolated `codex/electron-ui` worktree; user approved implementation. Use test-driven-development and verification-before-completion. Previous advisory review transport was unreadable; do not claim independent approval.

**Goal:** Preserve LCD pixel size across frame changes; provide 0.5×–6× presets; persist independent scales, clock preference and placement.

**Architecture:** Canonical skin geometry computes enclosing bounds from LCD output scale and display density. WindowMode owns geometry/mode and publishes render scale; a debounced settings writer owns ordered persistence and exit flushing. Renderer keeps source canvas and display port alive and applies an output-aligned transform. Existing native menu and automation boundaries remain.

**Tech:** Electron, TypeScript, React, Zod, Pino, Vitest, Playwright.

## Tasks

- [x] Add failing unit tests in `desktop/tests/unit/clock-geometry.test.ts`, `settings-store.test.ts`, `window-mode.test.ts`, `menu.test.ts`: presets, per-mode scale, frame toggle invariance, explicit vs manual density, serialized settings and restored clock center. Run `npm test -- tests/unit/clock-geometry.test.ts tests/unit/settings-store.test.ts tests/unit/window-mode.test.ts tests/unit/menu.test.ts` and record expected missing-feature failures.
- [x] Extend `desktop/src/shared/clock-geometry.ts` with factor/unrounded geometry and shared presets. Extend `desktop/src/core/schemas.ts` and add `desktop/src/core/view-settings.ts` with debounced patch merge, serialized updates, failure reporting and `flush()`. Test flushed edits and recovery after failure.
- [x] Update `desktop/src/main/window-mode.ts`: remembered per-mode scale, explicit rendering target vs manual fit, preserve LCD across frame changes, 0.5× normal minimum/clock minimum, display-density transitions, independent settled clock center, accessible restoration, preferred vs active clock state. Preserve runtime/fullscreen/focus safeguards.
- [x] Wire `desktop/src/main/index.ts`, `menu.ts`, `shared/contracts.ts`, `shared/locale.ts`, `shared/automation-contracts.ts`: shared preset submenu, async 1×/preset handlers and busy checks, automatic clock restoration on successful running, temporary exits without clearing preference, logging and exit flush. Update `GameScreen.tsx`, `App.tsx`, `app.css` for exact arbitrary scale and compact usable controls.
- [x] Add failing then passing real Electron coverage in `desktop/tests/e2e/chassis.spec.ts`: both-mode/frame invariance, preset output sizes and raster replication, manual fractional scale, same-UserData relaunch with distinct scales/position/options, idle startup and later ROM restore. Update legacy expectations intentionally changed by remembered scales. Extend `packaged.spec.ts` smoke for preset menu.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`; inspect small normal/clock screenshots. Resolve regressions before `npm run package:dir` and explicit `GNW_PACKAGE_TEST=1 npm run test:e2e -- tests/e2e/packaged.spec.ts`. GUI runs stay sequential.
- [x] Update `docs/desktop/chassis.md`, `automation.md`, `logging.md`, `validation.md` and approved spec status. `git diff --check`, local commit, confirm clean status; no merge/push.

## Guardrails

0.5× deliberately downsamples. Integer requested scale must survive enclosing-window rounding. Manual fit writes only for actual game window resizes, not maximize/fullscreen/dialogs/programmatic intermediate geometry. Clock drag/scale writes flush before quit. Restoring missing-monitor placement changes position without silently reducing scale. Current ROM/session/backend and source assets are unchanged.

Final evidence: typecheck/build/package:dir exit 0; 59 unit tests in 19 files; ordinary UI 9 passed / 6 explicit skips; explicit directory package smoke 1 passed. Review P2 idle-density and inaccessible controls fixes have regressions and were reviewed; equal-DPI control-width publication addressed. Full scope and limits: docs/desktop/validation.md. Local commit retains this worktree and branch.
