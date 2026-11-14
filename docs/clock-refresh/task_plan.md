# Desktop clock refresh
User explicitly requests master implementation first, then merge into special/windows-stock-dual and return a new Windows ZIP.
- [x] Inspect geometry, settings, menus, chassis controls and Windows acceptance tooling.
- [x] Add persistent clock opacity 20–100%, normal-mode opacity restoration and menu.
- [x] Remove 12px dock gap; Windows uses full screen bounds; verify topmost placement over taskbar.
- [x] Remove chassis focus/Space activation; retain pointer and configured keyboard input.
- [x] Move overlay to top-left, size it for small windows.
- [ ] Test master (unit/type/build and real Windows interaction), commit master.
- [ ] Merge master into special branch, package and verify both EXEs, return ZIP with matching hash.
