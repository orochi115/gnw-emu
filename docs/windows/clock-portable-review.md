# Windows clock and portable review

Independent review used the target machine's Grok CLI with the supplied source/diff, without GUI access or source edits. Three suggested blockers were checked against the actual runtime and source:

- HMENU conversion: Koffi's `GetPointerAddress` (`src/koffi/src/ffi.cc`) converts the native pointer to `uintptr_t`/BigInt; it does not return a JavaScript object's address. Real Win32 `#32768` menus and nested dock/settings submenus were enumerated through `MN_GETHMENU`, `GetSubMenu` and `GetMenuStringW`, and their commands executed successfully.
- Drag guards: a paused game retains `status=running` with `execution=paused`, so clock dragging is allowed. Empty/error sessions intentionally leave clock mode. Oversized docking retains source scale and accessible top-left placement, consistent with the pre-existing `dockBounds` contract.
- Portable marker: `desktop/portable.txt` is a new file included by `extraFiles`. Both the built ZIP and extracted package contain it. Actual launch, directory move/restart and explicit data override tests confirm the selected UserData locations.

Additional native-input regression testing found that Win32's modal menu loop consumes key releases. Holding ArrowUp, releasing it inside the menu and cancelling left `desiredMask=appliedMask=2`. Opening a native menu now blocks/neutralizes routing and flushes input before the modal loop. Closing unblocks routing and clears stale keyboard quarantine before dispatching the selected action. The real Session 1 acceptance checks neutral input and the next physical key press.
