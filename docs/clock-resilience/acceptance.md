# Clock resilience acceptance (2026-11-16)

> 个人路径和主机地址已替换为示例占位符；验证结果与提交记录保持原样。

Implemented on master (`8eea2fa`), then merged into `special/windows-stock-dual` (`88c20f9`). Later master commits improve the committed acceptance scripts and ownership test; they do not change the packaged application. Existing unrelated working changes and previous releases are preserved. No firmware BIN was added to Git.

The Windows package was built on `<user>@<windows-host>` using the clean pinned Unicode native build. Its source manifest records `88c20f9de29be3655b2f0cd53269c9255451491c`. D: ran out of disk space; only this task's incomplete build output was removed and the completed package was built on C:.

Local artifact: `../out/gnw-stock-clock-resilience/gnw-stock-special-0.1.0-win-x64.zip` relative to the parent workspace. Size 296568964 bytes; SHA256 `2427b27488102ca3df0644598d0dca0b6229a1b0d494c9953a8f9855ce816d19`. Native SHA256 remains `f9743e317d0f593eada11f10770e75fee4b1c06821071a0087157706fb98383f`; snapshots from the preceding Unicode package retain compatibility. The older pre-Unicode kernel's quick snapshots remain incompatible. Keep backups when migrating old UserData.

Validation:

- macOS master: typecheck/build; 252 unit/integration tests; four actual clock-context/ordinary idle/Zelda/Mario exit tests.
- Windows master: typecheck/build; 215 tests passed, two native prerequisites skipped; actual forced host ownership test passed, including preservation of an independent process.
- Special branch: local typecheck/stock build; 252 tests passed, two skipped. Windows typecheck; 217 passed, two skipped, and stock ZIP build.
- Real Windows Session 1 master and both extracted stock EXEs: half-scale three-button toolbar, button minimize/restore without waking the window through the watchdog, late taskbar reordering while already blurred repaired without a drag or bounds change; USB remains connected in clock mode. Manual USB control returns after leaving clock mode. An USB-off quick snapshot loaded via F8 in clock mode does not disconnect USB.
- Forced native PID termination triggers one new session, same profile and clock preference, USB connected; recovery and actual native/process/system memory metrics persist in logs. Normal UI exit and forced UI PID termination release its kernel.
- ZIP acceptance runs both EXEs simultaneously, checks restricted menus/CLI/drop/IPC/hotkeys, reads and writes both model saves, relocates the whole package between Chinese/emoji paths with spaces and reopens both models. Original bundled firmware hashes stay unchanged.
- Local ZIP CRC and SHA256 pass; four bundled firmware BIN hashes match the local original backups, native hash matches, both EXEs/profiles exist, and no UserData is bundled.

Machine-specific JSON evidence and checksum are stored next to the delivered ZIP in `out/gnw-stock-clock-resilience` in the parent workspace.

## Running regression checks

From `desktop`, run `npm run typecheck`, `npm test -- tests/unit tests/integration/native-owner.test.ts`, and `npm run build`. The ownership test forces only its spawned parent PID and verifies its child ends while an unrelated process survives.

On an unlocked interactive Windows Session 1, use `node tools/verify-clock-resilience.mjs`. For master set `GNW_TEST_PROFILE` to an existing Mario profile. For an extracted stock EXE set `GNW_CLOCK_EXE` to its absolute path; its data is always scoped to the package's `UserData/<model>`. Set `GNW_CLOCK_RESULT` to a fresh result path. The test uses Playwright and the committed `windows-native-ui.py`; Python is required for acceptance, not for the distributed application. The special branch also has `tools/verify-stock.mjs` with `GNW_STOCK_ZIP` for full ZIP/relocation/save acceptance.

## Diagnostics and limits

Stock logs are in `UserData/zelda/logs` or `UserData/mario/logs`. `recovery.failure/scheduled/attempt/succeeded/exhausted` include the profile, session and failure details. Automatic recovery is limited to three retries within five minutes, delayed 1/2/4 seconds, and is cancelled by exit/profile replacement. Unsupported builds, missing firmware and snapshot errors are not recovery triggers. Recovery keeps session files and does not automatically load a quick snapshot; abrupt crashes cannot guarantee preservation of unsaved game progress.

`memory.sample` is emitted approximately once per minute with native private bytes, working set, handles, system commit/limit/available bytes, plus Electron main and host metrics. It maintains one baseline for the current session; sustained growth produces a rate-limited `memory.growth` observation rather than declaring a proven leak or restarting on a memory threshold. Logging uses the existing bounded rotating files (10 MB, five retained files). Sampling errors are logged without stopping the emulator.

Even with no input, frame/audio/IPC processing creates short-lived allocations. A bounded retained footprint is the relevant expectation. The native default JIT allocation accounts for about 1 GiB of private committed memory. This short fault/recovery acceptance does not prove the root cause of the previous 35-hour allocation failure; the new logs provide evidence for a longer investigation.
