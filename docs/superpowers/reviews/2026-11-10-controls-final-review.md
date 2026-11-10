# Independent custom-controls review (approved)

## P1 — Real gamepad chords never activate

`desktop/src/renderer/hooks/gamepad-input.ts` emits a distinct `event.source` per control (`gamepad:p1:button0`, `gamepad:p1:button1`), while `desktop/src/core/control-router.ts:100` requires every component of a binding to have `input.source === event.source`. No two distinct buttons from the production reader can satisfy this condition. Core chord tests use an identical source string for both buttons and therefore miss the integrated behavior. The UI can record and save a two-button gamepad hotkey, but pressing it will never execute the action.

Use runtime device instance as the routing source (raw identity already includes inputIdentity), or normalize instance identity in router while preserving separate control cleanup. Add an integration regression that feeds actual GamepadInputReader events into ControlRouter for two-button chord press/release and two identical simultaneous controller instances.

## P2 — Cancel does not undo participation for newly seen controllers

`desktop/src/renderer/components/controls/ControlsDialog.tsx:243` restores participation from `initial.devices[fingerprint]?.enabled ?? device.enabled`. The `devices` prop is the continuously updated reader result, and its `device.enabled` has already been changed by `setDeviceParticipation` through the reader override. When a controller has no saved device preference (normal first use), uncheck participation and then Cancel: the fallback is now `false`, so Cancel reapplies false and leaves the controller disabled. Colliding devices have the same issue for per-instance participation. This contradicts the approved whole-page Cancel semantics.

Snapshot runtime participation before its first draft mutation (including automatically selecting duplicate capture sources), and restore that snapshot on Cancel rather than the latest reader state. Add an E2E for a neutral injected controller with no existing preference, toggle off, cancel, and assert its default A input works again; cover an identical-fingerprint pair independently.

## P2 — Renderer loss does not restore configuration geometry and can throw during save

`desktop/src/main/index.ts:370-373` handles renderer loss by calling transaction.close() but omits closeControlSettings()/windowMode.setModal(false). Once a settings dialog was open, WindowMode.modal remains true, its large minimum remains installed, and subsequent reloads show the game with modal geometry, ignore game resizing and report null render scale. If loss occurs during the settings write, transaction.close() explicitly throws "Control settings busy" from this event handler. Neither cleanly performs the required renderer lifecycle cleanup.

Coordinate renderer teardown with the outstanding save transaction, neutralize immediately, then restore modal geometry and menu state safely (without reviving capture or held input). Include renderer-reload/crash while open and while persist is pending in lifecycle coverage. A regular renderer reload also does not emit render-process-gone, so reset/isolation should cover its navigation/reload boundary explicitly.

## Evidence

Direct production-reader/router reproduction (esbuild-loaded current TypeScript) emitted sources `["gamepad:p1:button0","gamepad:p1:button1"]` and no actions after pressing both buttons for a configured two-button `audio.mute` chord. No production edits were made by reviewer.

## P3 — Device error is never displayed by the integrated dialog

`desktop/src/renderer/App.tsx` passes devices/subscription/participation into ControlsDialog but omits the hook's `gamepads.deviceError`. The dialog has the necessary `deviceError` prop and unavailable-device warning; a permission/API polling error therefore appears as no connected gamepad. Pass through the property so this implemented error state is reachable.

## Review result

Specification compliance is not yet approved because of the chord, Cancel, and renderer cleanup findings above. The shared schema/persistence transaction, keyboard capture draft semantics, turbo segments, conflict icons, both complete photographs, and 12 ordinary-key bubble placement otherwise follow the approved scope. No extra placeholder hotkey actions were found.

Code quality review is limited to the same defects until fixes are verified; there is no recommendation for unrelated refactoring. Fresh targeted verification passed 3 files / 19 tests and `npm run typecheck`. These tests do not cover the production-reader/router chord mismatch or runtime participation Cancel path.

## Follow-up review — fixes inspected 2026-11-10 21:22

The production reader now uses device-level source IDs, and its new reader-to-router regression covers same-device chords versus cross-device halves. DeviceParticipationDraft snapshots state before mutation and restores only connected instances; its two regression tests cover both enabled and disabled baselines and reconnect. App now passes deviceError. These three findings are resolved. Renderer teardown now restores WindowMode geometry and safely abandons an accepted pending write; the original renderer-loss throw/geometry finding is also resolved.

Fresh targeted verification passed 4 files / 22 tests and typecheck.

### P1 follow-up — Abandoning during the open release barrier can reopen unisolated capture

`ControlSettingsTransaction.open()` still returns a draft after its awaited `effects.flush()` without checking whether `abandon()` closed it in the meantime. `openControlSettings()` likewise proceeds to setModal/send `controls.open` without checking transaction identity or renderer availability after awaiting `open()` and clock-mode transitions. Reproduce: start open with a pending QMP flush, reload renderer (teardown calls abandon and sets opened=false), complete the barrier. The old pending open now displays a new capture dialog while `controlSettings.opened` is false, so main routing is not isolated and captured input can reach QEMU.

Invalidate an in-flight open on abandon/close and check its generation before exposing the draft and again before sending UI after any awaited clock transition. Add the pending-open/abandon/finish barrier regression; the current reload E2E waits until the dialog is already visible and does not exercise this race.

### P2 follow-up — Accepted save completion is not published to a reloaded renderer

When a save is pending during teardown, abandon intentionally allows it to commit. The newly loaded App calls `controls()` before the pending persist finishes and stores the old configuration. The later `apply()` updates only ControlRouter and publishes an input epoch, without sending the new effective ControlsSettings to the renderer. The renderer gamepad reader therefore continues using old device preferences/deadzone until the user opens settings again. Add an effective-controls change subscription/publication or defer initial settings response until the accepted write settles. Test pending-save/reload with device preferences, not only the main transaction's eventual config.

Direct current-TypeScript reproduction of the pending-open race returned `{ "opened": false, "draftReturned": true }` after calling open(), abandon(), resolving the release barrier, then awaiting the original open. No production edits.

## Final follow-up assessment — 2026-11-10 21:24

Both follow-up lifecycle findings are resolved in current code. Transaction revisions invalidate a pending open on abandonment and prevent its failure handler from closing a later draft; main checks the same revision and renderer availability after awaited transitions before showing capture. The regression explicitly abandons a pending open, starts a newer draft, completes the barrier, and proves only the newer draft survives. Main now publishes `controls.changed` after an accepted save; preload exposes the subscription and App installs it before its initial `controls()` response, discarding that older response when a changed event arrived. This updates the gamepad reader's effective configuration after reload.

Fresh verification: 4 targeted files / 23 tests pass; typecheck passes. No production edits by reviewer.

Specification and code quality review approve the inspected implementation with no remaining concrete findings from this review. Full Electron/QEMU regression, packaging and real-device validation remain the parent's acceptance work; this approval does not claim USB/Bluetooth hardware was tested.
