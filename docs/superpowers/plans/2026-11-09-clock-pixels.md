# Clock pixel scale implementation plan

**Goal:** Default to one QEMU pixel per Chromium output pixel, with/without the frame, allow smaller manual resizing, and provide a restore action.

**Approved behavior:** User selected default 1:1 with further manual shrinking. Entering clock mode, toggling its chassis and choosing Restore 1:1 reset the size. Arbitrary resizing fits proportionately, including below 1:1. Normal window restoration/session/focus rules remain.

**Architecture:** Main computes logical content bounds from the canonical skin geometry and the current display scale factor. Track the target 1:1 bounds so the renderer can distinguish exact pixel mode from manual fit. Renderer uses current devicePixelRatio and a CSS transform of the source-size canvas, aligned to the output pixel grid; the canvas/port/backend stay alive. When moving between displays, retain exact 1:1 if active, otherwise retain manually selected logical size. Density changes also trigger renderer layout without relying on window ResizeObserver alone. State/inspection expose density and canvas pixel scale.

**Physical scope:** At DPR 2, a plain LCD occupies 160×120 logical px; its backing/raster output remains 320×240. Zelda frame ~366×219 logical px, Mario ~364×218. macOS scaled display modes may resample the entire desktop again: application raster 1:1 is measurable, raw panel subpixels cannot be guaranteed by Chromium.

## Tasks

- [x] Tests first: extend `desktop/tests/e2e/chassis.spec.ts` for exact rendered LCD width×DPR=320 and height×DPR=240, pixel-grid origins, smaller resize with/without chassis, restore `view.actualSize`, frame continuity and diagnostics; watch current implementation fail.
- [x] Create `desktop/src/shared/clock-geometry.ts` using canonical skin metadata. Test DPR 1/2/fractional density in `desktop/tests/unit/clock-geometry.test.ts`; no duplicate hardcoded skin screen geometry.
- [x] Extend `desktop/src/main/window-mode.ts` to compute 1:1 bounds, reduce minimum to at most 80×48 logical px, restore size and watch display density. Keep normal minimum/bounds restoration. Update menu/main/IPC/contracts and automation allowlist; stable `view.actualSize` and `window.actualSize` actions; localize “Restore 1:1”. Small overlay should remain accessible.
- [x] Update `GameScreen.tsx`: exact 1:1 canvas transform, physical pixel grid positioning; manual fit below/above 1:1; resolution media-query watcher and window state integration. Expose DPR, rendered dimensions and pixelScale through `ui.inspect`. Validate actual captured screenshot with an alternating-pixel test pattern, not only CSS arithmetic.
- [x] Typecheck/unit/build, targeted + ordinary UI E2E, screenshot review, package + explicit package smoke. No backend/soak changes. Update `docs/desktop/chassis.md`, automation and validation notes, commit locally.

**Commands (desktop):** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e -- tests/e2e/chassis.spec.ts`, `npm run test:e2e`, `npm run package:dir`, `GNW_PACKAGE_TEST=1 npm run test:e2e -- tests/e2e/packaged.spec.ts`.

**Review considerations:** fractional window sizes rounded up but canvas remains exactly source×1/DPR; raw layout max-size CSS must not clamp source-size canvas before transform; align canvas origin globally after layout, and keep tiny window return/close controls visible. Reflow does not reattach display port. Watcher cleanup must not leak callbacks.

Review follow-up: exact mode is explicit; density changes tested both in exact/manual mode. Self-check additionally reproduced mixed-density boundary oscillation and photo-alpha contamination of LCD edges; both now have passing regressions. Final results and platform scope are in docs/desktop/validation.md.
