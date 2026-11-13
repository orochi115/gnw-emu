# Windows menu bar and clock dragging

Goal: Display horizontal menus in normal mode when they fit; prevent progressive clock growth; simplify clock context menus.

Design: Retain the frameless titlebar and Win32 HMENU dropdown adapter. Render the top-level labels in the existing 32 DIP titlebar; measure their natural width together with window controls and reserve a drag area. Collapse to the complete native hamburger popup only when space is insufficient. macOS retains its system menu. The main process owns descriptors and validates submenu ids/anchor coordinates. Use Windows SetWindowPos with SWP_NOSIZE for position-only dragging and docking; never round-trip dimensions through Electron setBounds/setPosition.

- [x] Capture Windows Session 1 before/after drag sizes and compare movement APIs.
- [x] Add failing clock menu, move-only geometry and menu descriptor tests.
- [x] Implement movement adapter, compact context menu, measured menu bar and trusted IPC.
- [x] Verify local units/typecheck/build and review the changes.
- [x] Rebuild ordinary and portable Windows packages, verify real menus, narrow fallback and constant drag dimensions in Session 1.
- [x] Deploy tested packages, commit/push master, synchronize remote source and clean up owned tasks.

- [x] Add beforePack UserData guard, unit regression and actual Windows builder rejection test; user confirmed old cleared portable output contained no data requiring preservation.
