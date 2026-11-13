# Windows menu bar and clock drag review

An independent read-only code reviewer examined the current diff, the new native positioning adapter, trusted submenu IPC, renderer measurements, input behavior and acceptance tests. No actionable defects were found. Targeted review validation passed 33 tests in four files; local full validation passed 230 tests in 44 files, type checking and build.

Session 1 baseline on Windows at 150% DPI reproduced growth: three 20-sample real drags increased width from 488 to 576 DIP (a second run reached 580). Electron position-only `setBounds` and `setPosition` also grew width by 40 DIP over 20 calls. An external native `SetWindowPos` experiment using `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE` performed 20 moves without changing width or height. Both dragging and docking now use that move-only adapter on Windows.

The horizontal labels are drawn in the existing frameless titlebar. Dropdowns remain native Win32 HMENU. Width is measured from localized labels and current controls with 48 DIP reserved for dragging; narrow windows use the full native popup. macOS retains its system menu. Runtime verification must assert window and client dimensions after repeated physical drags and edge docking, and enumerate real menus in both normal layouts and clock mode.

Follow-up review found no important issues in the new package-data guard. Installed electron-builder awaits emitBeforePack before staging/clearing output; portable config inherits the hook. A real Windows builder run rejected an output with UserData (exit 1) before changing its settings hash or old-package sentinel. The user confirmed the cleared old portable output held trial data only. Final local units: 231 passed in 45 files; Windows focused guards/geometry: 20 passed.

Runtime acceptance passed eight cases plus a separate Chinese menu bar check. Physical clock window and client sizes remained 320×240 throughout repeated drags and docking. At 150% DPI Electron's enclosing DIP rectangle may differ by one DIP depending on origin rounding, so the runtime assertion uses physical GetWindowRect/GetClientRect dimensions and separately bounds DIP deviation.
