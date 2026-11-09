# Display pixel scale and frame switching

Status: proposed for user review. No implementation changes yet.

## Behavior

The unit of scale is a QEMU LCD pixel relative to a Chromium output pixel. The source LCD is 320×240. At 1× on a DPR 2 display, the LCD occupies 160×120 logical pixels. This is the same definition as the existing clock 1:1 action; macOS desktop scaling can still resample the composed desktop.

Normal mode and desktop clock mode each remember an independent positive scale in application settings, including fractional values from manual resizing. Defaults for settings without these fields are normal 4× and clock 1×. ROM profiles and the QEMU process do not own this preference.

Enabling/disabling the chassis retains the current LCD scale and adjusts the enclosing window around its center. Changing Mario/Zelda applies the same scale with the new canonical chassis geometry. It does not reset the clock scale to 1×. Returning between modes uses the corresponding remembered scale; existing focus release, on-top restoration and session continuity remain.

Add View → Pixel Scale and the same submenu to the clock context menu: 0.5× and 1× through 6×, showing the source LCD output dimensions. At 0.5×, the LCD occupies 160×120 output pixels (80×60 logical pixels at DPR 2); downsampling is intentional. The existing Restore 1:1 action remains and selects 1× for the current mode. Selecting a menu item affects only the active mode. A menu radio item is checked only when the active scale matches that preset; other manual fractional scales have no preset checked. Entries whose complete window would exceed the current display work area are disabled rather than silently selecting a different scale. No new keyboard accelerators collide with game controls.

Manual resizing remains available, including below 1× in clock mode. Save the effective LCD scale after the resize settles, not each intermediate event. Programmatic frame/mode/scale changes must not feed resize events back into the saved factor. Rounding enclosing window bounds must not convert a requested integer scale into a fractional one.

Maximized/fullscreen views may temporarily fit their available area. Their transient fit does not overwrite the remembered windowed factor. Frame switching retains the actual LCD scale; if the new chassis cannot fit the fixed maximized/fullscreen viewport, leave that state safely and resize the enclosing window rather than reducing the LCD. A resulting window may extend beyond the work area at a large manually chosen factor; keep controls accessible and do not silently reduce the factor. An explicit integer selection also leaves maximized/fullscreen state safely and applies a windowed size. Normal mode restores its prior maximized state after a clock round trip. Ordinary windowed mode restores the remembered normal scale with the current frame state rather than restoring incompatible old dimensions.

Small normal game windows must remain operable: hide/truncate the title text and retain menu/window controls when necessary. Empty and ROM creation views retain their usable minimum size; their layout changes do not overwrite game scale. Clock minimum size and blur input safety remain.

## Persistent clock placement and option states

The user's two option states mean Show Device Frame and Desktop Clock Mode. Continue persisting the existing shared `showChassis` preference, and add the user's preferred clock-mode state. An explicit mode toggle updates that preference; closing while in clock mode keeps it enabled. Temporary exits due to a stopped/failed runtime, shutdown cleanup or absence of a running ROM must not overwrite the preference. On launch without a ROM, keep the usable ordinary empty window; restore clock mode once a ROM successfully reaches running. Do not introduce automatic ROM loading or inject TIME as part of this change. A failed startup must leave ordinary recovery controls accessible.

Persist the last clock position independently of ordinary window position and of each mode's scale. Store the last settled logical bounds as a placement anchor plus advisory display identity, while the remembered factor and current display density determine restored size. Restore the remembered center on entry/relaunch; frame/scale changes retain that center. Debounce dragging and flush pending placement on orderly exit. Programmatic intermediate bounds must not overwrite the settled placement.

If a display has been disconnected or its work area changed, relocate the restored clock into the nearest available work area so it can be reached. Keep the requested pixel factor; clamp placement, not scale. Restoring a position must retain the existing stable display-density transition behavior and avoid a monitor-boundary resize loop.

## Alternatives

Recommended: remember the actual pixel scale for each mode, including manual fractional scales. This preserves the user's visible choice across frame changes and restarts.

Remembering only integer menu choices would be simpler, but restarting would discard manual sizing. Remembering window dimensions would retain current problems because frame geometry and display density change the LCD size.

## Implementation boundaries

Main owns current mode, independent saved factors, display density, canonical skin geometry, native bounds and native menu state. Renderer receives the target scale and fits only for manual/transient layouts. The existing output-pixel alignment and photo aperture clipping extend to all explicit integer factors. Keep canvas/port/QEMU lifetimes unchanged.

Extend the existing strict settings schema with scale defaults, clock preference and optional placement. Use serialized atomic settings writes and debounce manual updates. Flush pending scale and placement writes through the orderly application exit path. Persist failures are logged and surfaced; the currently visible manual size remains usable, with the previous durable value retained on disk.

Expose active and per-mode scales through trusted state/automation inspection. Add stable allowlisted scale menu IDs and Pino events for mode, factor, density, source of change and persistence failures. Document settings semantics, menu commands and platform verification limits.

## Acceptance evidence

- Measure the LCD before/after frame toggles for both models and modes, including manual fractional scales; scale stays equal within output-pixel layout tolerance while window dimensions change.
- Select 0.5×/1×/2×/3× and verify LCD dimensions×DPR equal source dimensions×factor, with screenshot sampling/replication checks and the existing aperture-edge regression. Verify small normal-mode controls remain usable at 0.5×.
- Resize each mode independently, switch modes repeatedly, restart with the same test UserData and confirm distinct values survive. Exercise defaults and serialized settings writes.
- Move the clock, close with clock enabled, relaunch with a ROM and confirm placement, factor and both options restore. Relaunch without a ROM, then load one; restore only after successful startup. Runtime failure and shutdown must not clear the saved clock preference. Simulate a missing monitor and verify accessible placement.
- Keep model switching, different-DPI monitor simulation, tiny clock resizing, normal/maximized/fullscreen restoration and focus/input cleanup regressions.
- Typecheck, unit suite, UI E2E, production build and updated macOS directory package smoke. Linux/Windows actual display behavior remains unverified without those systems.

Review note: the dispatched reviewer response arrived as an opaque `pv_` transport token and could not be read. No independent review approval is claimed. Self-review clarified the maximized/fullscreen overflow case above; this proposal still awaits user review.
