# Desktop clock refresh acceptance — 2026-11-14

Implemented on master (`d47a785`, `5847269`) and merged into special/windows-stock-dual before packaging. Packaged source revision: `fbbaab456547f73f6405b4994aff9c853afbc851`; subsequent changes only extend verification and acceptance documentation.

- Clock context menu offers 20–100% opacity. Native opacity 60% persisted on disk and after restart; normal mode restored 100%.
- Windows docking uses full display bounds with no intentional margin; magnetic docking shares this geometry. Actual bottom-left docking reaches the screen edge, including taskbar overlap.
- Win32 WindowFromPoint hit testing found the clock above Shell_TrayWnd before/after taskbar hover and clicks, repeated clicks, and switching through another foreground window. The clock remained unfocused after re-raising.
- Per-button focus/Space/Enter activation and focus rings were removed. Pointer capture and configured keyboard mapping remain. Actual pointer interaction did not focus chassis controls.
- Toolbar starts at (2, 2) logical pixels in the upper left. At half LCD scale, Zelda buttons measured about 19.6 logical pixels; both packaged models passed compact-toolbar checks.
- Local master: typecheck/build, 237 unit tests, and previously run real macOS chassis/input/clock E2E passed. Local merged special: 237 unit tests passed, 2 skipped. Windows merged special: typecheck/build, 202 unit tests passed, 2 platform skips.
- Extracted ZIP: both models render stock screens, restricted CLI/menu/drop/IPC/hotkey routes remain blocked, Zelda save/load works, both EXEs run together, complete-directory relocation preserves saves. Firmware hashes remain unchanged.
- Local ZIP CRC and SHA256 match the Windows-tested artifact. All four bundled firmware files match the original local backups. Both model EXEs/profiles/icons exist, and no UserData was packed. Native staging provenance validation passed.
- No firmware BIN was added by these changes; temporary Windows verification tasks were removed.

An exploratory full local Vitest run could not validate 24 existing native integration scenarios because the local native binary hash differs from its stage manifest. Those fixture failures are separate from the desktop checks above and the correctly staged Windows artifact.

Returned ZIP: `/Users/sakura/GameWatch_Zelda/out/gnw-stock-clock-refresh/gnw-stock-special-0.1.0-win-x64.zip` (296560055 bytes, about 283 MiB).

SHA256: `a71b52c188c413db92523303359453d5892a6ecf5dfd0cbb98ed5579117d1b91`.

Evidence beside the ZIP: windows-master-verification.json, windows-stock-verification.json, windows-clock-zelda-verification.json, windows-clock-mario-verification.json, local-verification.json and screenshots.

Existing limitation: install into an English/ASCII-only application path and parent directories. The pinned Windows native kernel does not support Chinese paths. English paths containing spaces passed relocation. The package README records this requirement.
