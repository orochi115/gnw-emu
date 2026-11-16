# Using gnw-emu

[English README](../README.md) · [中文 README](../README.zh-CN.md)

## Firmware images

To dump your Mario or Zelda Game & Watch, follow [GnWManager's probe setup](https://github.com/BrianPugh/gnwmanager#compatibility) and [unlock / backup tutorial](https://github.com/BrianPugh/gnwmanager/blob/main/tutorials/unlock.md), or the [Game & Watch backup guide](https://github.com/ghidraninja/game-and-watch-backup).

In **File → Make ROM…**, select the model matching your dump and provide:

| Field | GnWManager stock backup | Full dump |
| --- | --- | --- |
| Internal flash (required) | `internal_flash_backup_mario.bin` or `internal_flash_backup_zelda.bin` | `bank1.bin` |
| External flash (required) | `flash_backup_mario.bin` or `flash_backup_zelda.bin` | `ext.bin` |
| Bank 2 (optional) | A separate Bank 2 image, if available | `bank2.bin` |
| SD card (optional) | A prepared SD card image for SD firmware | A prepared SD card image |

The `itcm_backup_*.bin` file is not the internal flash image. Keep it with your hardware backup, but do not select it in Make ROM.

Click **Save and Load…** and choose a filename ending in `.gnw.json`. This file references your images; it does not contain or compile firmware. Reopen it with **File → Load ROM…**, the recent ROM menu, or by dropping the configuration into the main window. Raw `.bin` files must first be combined into a configuration.

Image paths are relative to the configuration file; absolute paths also work. Keep the configuration and source images together when moving them. The bundled `profiles/mario.gnw.json` and `profiles/zelda.gnw.json` expect firmware in `../../firmware` relative to the profile directory; use Make ROM for your own layout.

If stock firmware shows **PRESS TIME BUTTON**, press `T`. Press `G` for game selection and `T` for the clock.

## Controls and display

Use the keyboard, click the device buttons, or connect a gamepad. Standard gamepads have default bindings; other controllers can be mapped in **Settings → Button Mapping…**. Record a binding, optionally enable turbo, then click **Save** to apply it. **Settings → Hotkey Settings…** configures application shortcuts. Both models share these settings. [Detailed controls guide (中文)](desktop/controls.md)

**View → Show Device Frame** switches between the photographed device and the screen alone. **View → Pixel Scale** changes the LCD size. **View → Desktop Clock Mode** turns the running device into a compact, always-on-top window, keeping the same firmware session. Press `T` to display the stock clock. Right-click the clock window for docking, scale, frame and exit options. [Display and clock details (中文)](desktop/chassis.md)

The **Device** menu controls execution, cold start, battery presence, USB power and charge level. `C` toggles USB power; `-` / `=` adjust charge. Disconnecting both battery and USB removes power from the device. Pausing execution freezes its virtual timers.

## Saves and your source images

On first load, gnw-emu copies the source images into a separate session. Subsequent runs use that session's working images, preserving firmware settings and in-game saves without writing back to the originals. Recreating a configuration gives it a new identity and separate saves; reopen your existing `.gnw.json` to continue the same device.

Instant states capture CPU, RAM, peripherals and flash. Use `F5` to save, `F8` to load, and `F6` / `F7` to select one of ten slots. Loading rolls back the session's flash, including in-game saves. States require the same emulator binary and support external flash up to 64 MiB; SD sessions do not support them. Updating the emulator can make old instant states incompatible, so retain the old build if you need them. [Detailed state guide (中文)](desktop/savestates.md)

| Application | User data location |
| --- | --- |
| Development | `<repository>/UserData` |
| Windows directory package | `%APPDATA%\gnw-emu-desktop\UserData` |
| Windows portable ZIP | `UserData` beside `gnw-emu.exe` |
| macOS directory package | `~/Library/Application Support/gnw-emu-desktop/UserData` |

`--user-data-dir=PATH` overrides the data location. Working images and instant states live under `kernels/gwemu/sessions/<profileId>`. Back up the entire user data directory after fully exiting the application. Legacy emulator user data is not imported automatically.

For Windows portable use, extract the entire ZIP, retain `portable.txt` beside the executable, and move the whole folder to keep settings and saves. Firmware image references still need to resolve. [Windows portable details (中文)](windows/README.md#绿色-portable-包)

## Retro-Go and SD firmware

Both Flash-only and SD builds use the maintained Retro-Go SD sources. Prepare the firmware images first, then select them in Make ROM. For SD firmware, also supply the card image and select the wiring matching the firmware: `spi1` (hardware SPI) or `ospi` (software SPI on external flash pins).

- [Retro-Go builds and assets (中文)](retrogo.md)
- [SD images, wiring and card updates (中文)](sdcard.md)
- [Launcher scripts (中文)](desktop/launchers.md)

Some patched stock / dual-boot firmware uses **Left + GAME** (`←` + `G`) from the stock clock to enter Retro-Go. This depends on how that firmware was built.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Image not found | The image path relative to the `.gnw.json`, and whether you moved either file. |
| Wrong or blank display | The model and matching internal / external firmware pair; for SD, the card and wiring. |
| Device has no power | Connect battery or USB in **Device**. |
| Device is paused | Choose **Device → Resume**. |
| Instant state unavailable | SD attachment, flash capacity, and emulator build compatibility. |
| A new configuration has no old saves | Reopen the original configuration; saves belong to its profile UUID. |

For a reproducible problem, [open an issue](https://github.com/orochi115/gnw-emu/issues) with your OS, emulator commit or build, model, firmware type, steps, and relevant [logs](desktop/logging.md). Keep firmware dumps out of the issue. Known device gaps and validation scope are recorded in the [device review](research/2026-11-13-gwemu-stock-settings-and-device-review.md), [macOS acceptance](research/2026-11-13-gwemu-product-acceptance.md), and [Windows acceptance](windows/acceptance.md).
