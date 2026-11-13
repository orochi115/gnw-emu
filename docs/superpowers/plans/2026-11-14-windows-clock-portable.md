# Windows menus, clock interaction and portable package

Goal: use real Win32 popup menus on Windows, restore usable desktop-clock interaction, and offer a zip package with data beside the executable.

Architecture: retain Electron Menu as the single command/state/accelerator model; a Windows-only Koffi adapter presents HMENU and dispatches the existing MenuItem.click wrapper. Keep macOS menus unchanged. On Windows, clock dragging uses pointer capture and trusted IPC rather than caption hit testing, so right-click and double-click stay client events. Clock controls follow the game in DOM order, reveal only at their hotspot, and are excluded from dragging. Disable maximization while clock mode is active. Add edge docking and snap near a work-area edge on drag release; preserve scale and saved position. Portable builds include a marker next to the executable; its UserData directory holds settings, saves, logs and Electron host files. Explicit --user-data-dir retains precedence. Ordinary packages retain AppData.

- [x] Reproduce current Windows clock right-click, double-click and controls in Session 1 with isolated data.
- [x] Add failing native-menu projection/dispatch, clock drag/capability, edge geometry and portable path tests.
- [x] Implement Win32 menu adapter with Unicode labels, submenus, checks/radio checks, disabled states, accelerator labels, role dispatch and owned HMENU cleanup.
- [x] Implement Windows clock pointer dragging, capability restoration, toolbar ordering/hotspot and work-area edge snapping; leave macOS caption dragging intact.
- [x] Add marked portable zip configuration, npm/PowerShell build switches and usage documentation.
- [x] Run affected tests, full units, typecheck/build; build ordinary and portable Windows packages.
- [x] Verify real Win32 #32768 menus, their commands, dragging/snap, right-click, double-click, toolbar and portable restart/persistence in Session 1. Protect user's existing instance/data.
- [x] Review, deploy verified ordinary package, deliver portable zip, commit/push master under prior authorization and sync Windows source.
