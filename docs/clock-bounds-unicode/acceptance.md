# Screen limits and Unicode paths acceptance

Implemented on master before merging into `special/windows-stock-dual`.

- Master runtime: `38a6ce1`; mixed-density fixture correction: `f936cba`; native/GUI acceptance tools: `40b277b`.
- Native pin: `11a0143b04292b83a5ca0d40f561885b091ba116`, built from clean source into `build/gwemu-windows-unicode`.
- Native SHA256: `f9743e317d0f593eada11f10770e75fee4b1c06821071a0087157706fb98383f`.
- Special merge: `5d49524`; packaged source revision: `b68a78ebda03c17856e834ce16888bbf52f310b6`. Later verification/documentation commits do not change packaged runtime.

## Regression evidence

Before the fixes, clock containment tests failed for Windows display bounds and macOS work areas. The native ASCII session/save/load/restart regression passed, while the same Chinese/emoji paths failed startup; Unicode raw-disk opening also failed with file-not-found.

After the fixes:

- Local master typecheck/build and 241 unit tests passed; real macOS chassis/input/clock E2E: 9 passed.
- Windows master typecheck/build and unit tests: 204 passed, 2 platform skips.
- Fresh Windows native regression: 3 passed, 0 failed. ASCII and Chinese/emoji profile/image/session/lock/snapshot paths support startup, save/load and restart. Chinese/emoji raw-disk open/query passed; input images remained unchanged.
- Actual Windows master GUI with Chinese/emoji UserData passed all four held-mouse corner drags and on-release checks. Native window/client pixel sizes stayed identical at 150% DPI. Existing opacity/restart, taskbar coverage, no stolen focus, compact top-left toolbar and no chassis focus checks passed.
- Merged special typecheck passed; local unit tests: 241 passed, 2 skips; Windows unit tests: 206 passed, 2 skips.

## Portable package

- Both packaged EXEs passed real Windows clock acceptance from a Chinese/emoji application directory: all four held-mouse drags and released positions stayed inside the monitor, with unchanged native pixel dimensions. Opacity persistence, taskbar hover/activation, foreground interaction without stolen focus, compact toolbar and chassis input checks passed.
- Both fixed profiles passed simultaneous startup, restricted CLI/menu/drop/IPC/hotkey checks, and save/load. The whole application was moved into a second Chinese/emoji directory with spaces; both models relaunched and actually loaded their saved snapshots. Bundled firmware remained unchanged.
- Interactive scheduled task finished with result 0. Acceptance helper now dispatches native menu actions after inspector evaluation and waits for Windows executable/DLL handles to release before relocation. The PowerShell runner reads the JSON report explicitly as UTF-8.
- ZIP: `out/gnw-stock-bounds-unicode/gnw-stock-special-0.1.0-win-x64.zip`, 296,562,376 bytes.
- SHA256: `6a623a9331b8cf070b03bf09de8af4b21fdfb7520d6a7ccd7e1ba3515869b99f`.
- Local validation passed ZIP CRC, all stock manifest hashes, the native SHA256, both EXEs/profiles/icons, absence of packaged UserData, and all four firmware hashes against the original local backups. Local SHA256 equals the Windows-tested ZIP.

Reports and screenshots are alongside the local ZIP: `windows-stock-verification.json`, `windows-clock-{zelda,mario}-verification.json`, `windows-master-verification.json`, `windows-unicode-native-verification.json`, `windows-stock-unit.json`, `windows-native-build-manifest.json` and `local-verification.json`.

## Compatibility and privacy

The updated native binary changes its SHA256. Quick snapshots bind that binary identity, so snapshots from the previous package cannot load in this package. Updating does not delete them. Game session data uses the same profile-ID directories. Keep the prior package and a UserData backup when old quick snapshots are needed.

No firmware BINs were added or changed in Git. Firmware is bundled only in the private ZIP. Earlier delivered ZIPs, native build directories and unrelated user files are preserved.

Real Windows acceptance uses the available single monitor at 150% DPI. Negative origins, cross-monitor movement, display removal and oversized clocks are covered by unit tests; actual multi-monitor hardware was not available for this run.
