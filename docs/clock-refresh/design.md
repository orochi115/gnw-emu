# Desktop clock interaction update

Implement on master first, verify, then merge master into special/windows-stock-dual and return the portable Windows stock package.

Clock opacity uses a new clockOpacity preference (0.2–1, default 1) and a clock context submenu of 100% down to 20%. Apply native BrowserWindow opacity only in clock mode; normal mode is opaque. Persist using the existing coalesced view settings queue and flush before confirming menu operations.

Remove the 12-pixel dock gap. Windows clock docking/magnetism use full display bounds so a bottom-docked clock can occupy the taskbar area. Other platforms retain the work area. Request the screen-saver topmost level and validate actual Windows hit testing over Shell_TrayWnd, including hover, rather than inferring support from the topmost flag.

Chassis controls keep pointer capture and configured global keyboard mappings. Remove per-button focus, SVG focus indicators and focused Space/Enter activation; tabIndex is -1. General menus/dialogs keep their keyboard controls.

Move the hover toolbar to 2px from the top-left. Its controls scale with window width from 12 to 28 logical pixels, so tiny windows use smaller controls. Keep hover-only disclosure and return/close actions.

Validation: unit persistence/range/menu/geometry tests, real macOS input/chassis/clock E2E tests, Windows native menu opacity/persistence/restart, flush screen docking, taskbar overlap hit testing, toolbar placement/size and no chassis focus. After merging, recheck restricted stock EXEs and actual ZIP relocation. Firmware remains private packaging input and must not enter Git.
