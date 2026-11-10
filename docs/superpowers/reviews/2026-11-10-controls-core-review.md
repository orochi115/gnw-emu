# Core controls review

Reviewed Tasks 1–2 against the approved controls design. No production files were edited. Focused verification passed: `npm test -- tests/unit/controls.test.ts tests/unit/control-router.test.ts tests/unit/settings-store.test.ts` (3 files, 20 tests).

## Findings

### P1 — Stale-generation presses bypass held-input quarantine

`desktop/src/core/control-router.ts:59`

The generation check returns before updating raw held state. A press sent with the preceding epoch while configuration isolation is opening is correctly prevented from routing, but is also omitted from quarantine. If that key remains physically held and its next repeat arrives with the current epoch after configuration closes, the router treats the repeat as a new press and forwards it to the game. This violates the requirement that inputs held during configuration must first release before resuming.

Reproduced using the current router: capture epoch 0; call `setBlocked(true)`; send `KeyA` down with epoch 0; call `setBlocked(false)`; send another `KeyA` down with the current epoch, without any intervening up event. A callback `{ bit: 4, down: true }` is emitted.

Keep stale presses from dispatching while retaining sufficient raw/quarantine state to suppress subsequent repeats until release, particularly during an isolation boundary. Add a regression that uses a stale epoch for the first blocked press, then current-epoch repeats after close, and confirms an explicit release followed by a fresh down is accepted.

### P2 — Partially overlapping gamepad chords lack conflict warnings

`desktop/src/shared/controls.ts:342`

Conflict detection only recognizes subset relationships. Two same-device chords that share a button but neither contains the other can both execute under one reachable held-button sequence, yet neither receives a warning. For example, map buttons `[0, 1]` to `audio.mute` and `[1, 2]` to `view.chassis`, then press 0, 1 and 2 on one instance. The current router invokes both actions, while `findConflicts` returns `{}`. The spec defines conflicts by reachable simultaneous effects and describes unrelated gamepad buttons as not blocking chords; warning only about containment misses this shared-button case.

Extend chord conflict analysis to compatible device combinations with overlapping required buttons, including partial overlap, and add a test that checks both sides receive warnings. Preserve the existing distinction between exact keyboard modifier sets and between different devices.

## Verification notes

Both findings were reproduced directly against the live TypeScript files, loaded through the installed TypeScript transpiler; no copied implementation was used. Existing tests cover normal current-epoch quarantine and contained chords, so those passing tests do not exercise either case above. Schema defaults, source OR aggregation, configured physical key matching, default/explicit turbo phases, slow-QMP scheduler bounds, and actual settings JSON persistence otherwise showed no additional concrete defects in this review.

## Follow-up resolution assessment

Both findings are resolved in the current files. The router records stale held presses and quarantines newly observed stale sources before returning without dispatch, so current-epoch repeats after isolation remain suppressed until release. The new regression exercises the exact reported sequence and verifies fresh presses work after the release. Conflict detection now tests shared compatible inputs rather than containment alone; its regression verifies warnings on both partially overlapping chords and no warning for an incompatible device fingerprint.

Fresh verification: `npm test -- tests/unit/controls.test.ts tests/unit/control-router.test.ts tests/unit/settings-store.test.ts` passed 3 files / 22 tests. Reviewed the changed implementation and the two added regressions; no additional findings in this follow-up scope. No production files edited by the reviewer.
