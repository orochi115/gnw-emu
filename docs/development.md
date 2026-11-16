# Build and development

[README](../README.md) · [User guide](user-guide.md) · [Desktop internals](desktop/README.md)

The Electron desktop is built on [slash-proc/gwemu](https://github.com/slash-proc/gwemu), using a pinned [gnw-emu integration fork](https://github.com/orochi115/gwemu). Build the native kernel on the target platform, then build the desktop. Firmware dumps, game ROMs and SD images are separate user inputs and are never bundled.

## macOS / Linux

Install Node.js 24+, Python 3.11+, a C/C++ compiler, Ninja, CMake, pkg-config, GLib, Pixman, libpng, liblzma and zlib. On macOS, install Xcode Command Line Tools and the libraries with Homebrew:

```sh
xcode-select --install
brew install node@24 python ninja cmake pkg-config glib pixman libpng xz
```

Make sure `node` resolves to version 24 or newer. On Linux, use the equivalent distribution packages (including development headers and Python venv support). Linux desktop packaging has not yet been validated.

```sh
git -c core.autocrlf=false clone https://github.com/orochi115/gnw-emu.git
cd gnw-emu
git submodule update --init externals/gwemu externals/gnwmanager
scripts/build.sh
cd desktop
npm ci
npm run build
npm run dev
```

First configuration downloads pinned upstream build dependencies. The default kernel is `build/gwemu/qemu-system-arm`. `scripts/build.sh` delegates to `build_gwemu.sh`; it does not inject retired machine sources or patches. `gnw-build-manifest.json` records source commits, configuration, toolchain and executable hashes.

If sources or build options change, the script rejects incompatible existing objects. Use a fresh `GWEMU_BUILD_DIR` rather than mixing builds; custom native paths must also be supplied to the desktop launch and staging tools as appropriate. Build provenance is recorded, but byte-for-byte reproducibility across hosts is not promised.

After building, run `scripts/run.sh` from the repository root to open an empty desktop and create a configuration with your own images. To launch an existing configuration:

```sh
scripts/run.sh /absolute/path/device.gnw.json
scripts/run_backup.sh /absolute/path/full-dump
SD_WIRING=spi1 scripts/run_sd.sh /absolute/path/full-dump
SD_WIRING=ospi scripts/run_sd.sh /absolute/path/full-dump
```

`run.sh mario` / `run.sh zelda` use the bundled profiles, which reference firmware outside the repository. They are convenient only when those image paths exist. [Launcher details](desktop/launchers.md)

## Windows

Install Node.js 24+, Python 3.11+ and Git for Windows. In PowerShell, from a fresh clone:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\bootstrap.ps1 -SkipArm
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\run.ps1
```

The desktop and gwemu are native Windows processes; MSYS2 UCRT64 is used for building. `-SkipArm` skips the ARM firmware toolchain. If you also develop firmware, use `-CoreToolchain` instead. See the [Windows guide](windows/README.md) for dependencies, custom paths, firmware/core builds and validation.

## Validation

From `desktop`:

```sh
npm run typecheck
npm test
npm run test:e2e
```

Integration and end-to-end cases need your own firmware and, for some cases, prepared SD assets. Consult [desktop validation](desktop/validation.md) and the [Windows test instructions](windows/README.md#验证) before running hardware- or platform-specific suites.

Longer and packaged checks are opt-in:

```sh
GNW_SOAK=1 npm run test:e2e -- tests/e2e/display-soak.spec.ts
GNW_PACKAGE_TEST=1 npm run test:e2e -- tests/e2e/packaged.spec.ts
```

[macOS product acceptance](research/2026-11-13-gwemu-product-acceptance.md) and [Windows acceptance](windows/acceptance.md) record the tested scope. Physical modified devices and real controllers were not part of that acceptance; emulator results do not establish hardware compatibility. See the [device review](research/2026-11-13-gwemu-stock-settings-and-device-review.md) for known peripheral and Retro-Go boot gaps.

## Packaging

On macOS / Linux, from `desktop`:

```sh
npm run package:dir
```

Staging requires a clean, pinned gwemu source tree and a valid manifest whose hash matches the executable. `GNW_QEMU_BINARY` can select another native build for staging; `GWEMU_BUILD_MANIFEST` selects its manifest. These overrides do not bypass provenance checks.

macOS staging copies non-system dylibs, rewrites loader paths and applies ad-hoc signing. The generated application is not Developer ID signed or notarized. Linux staging needs `ldd` and `patchelf`, uses `$ORIGIN/lib`, and excludes glibc. Package on the native target: an Electron shell built for another OS is not a substitute for its kernel and runtime libraries.

On Windows, from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1 -Package
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1 -Portable
```

The directory package is under `desktop/release/win-unpacked`; the portable ZIP is under `desktop/release/portable`. Packages include the native kernel, dependencies and manifests, and run without Node.js, Python or MSYS2. Keep the entire package together. [Portable data and packaging safeguards](windows/README.md#绿色-portable-包)

## Managing the running device

Device management is based on [BrianPugh/gnwmanager](https://github.com/BrianPugh/gnwmanager). Install the [integration fork](https://github.com/orochi115/gnwmanager) from the pinned submodule in a Python virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e externals/gnwmanager
.venv/bin/python -m gnwmanager sessions
.venv/bin/python -m gnwmanager --session UUID info
.venv/bin/python -m gnwmanager --session UUID shell
```

Load a ROM in the desktop first. With multiple active devices, select an exact session UUID. The CLI provides backup/verification, region restore, flashing, filesystem operations, screenshots, monitoring, GDB and protection-state management. Physical backends remain explicit. Windows uses the Python environment and authenticated local transport described in its [platform guide](windows/README.md#固件核心与-manager).

The desktop owns QMP and coordinates manager power/input operations. During management or debugging, conflicting ROM changes, input and instant states are gated. A lease cannot silently move to another ROM; quitting or losing the native process revokes its endpoints. Interrupted writes report partial completion or uncertain persistence. [CLI contract and acceptance](research/2026-11-13-gwemu-session-manager-cli.md)

## Upstream projects

| Project | Original repository | Integration fork |
| --- | --- | --- |
| gwemu | [slash-proc/gwemu](https://github.com/slash-proc/gwemu) | [orochi115/gwemu](https://github.com/orochi115/gwemu) |
| GnWManager | [BrianPugh/gnwmanager](https://github.com/BrianPugh/gnwmanager) | [orochi115/gnwmanager](https://github.com/orochi115/gnwmanager) |
| Retro-Go SD | [sylverb/game-and-watch-retro-go-sd](https://github.com/sylverb/game-and-watch-retro-go-sd) | [orochi115/game-and-watch-retro-go-sd](https://github.com/orochi115/game-and-watch-retro-go-sd) |

Build scripts use the integration versions pinned by this repository.

## Project map

| Path | Purpose |
| --- | --- |
| `externals/gwemu` | Pinned native emulator integration |
| `externals/gnwmanager` | Emulated/physical device management |
| `externals/retro-go-sd`, `externals/cores` | Firmware and emulator cores |
| `desktop` | Electron UI, profiles, sessions, automation and packaging |
| `harness`, `tests`, `hwtest` | Native, manager and hardware validation |
| `scripts` | Build, image preparation and launch tools |
| `docs` | User guides, architecture, designs and acceptance records |

Electron main, preload and renderer are built separately. Sandboxed preload is CJS; main and utility processes are ESM. Keep Node business modules out of the renderer. Standalone Node CLIs in `desktop/dist-cli` reuse the core without Electron. Configuration or contract changes should update the relevant documentation and checks.

[Architecture](desktop/architecture.md) · [Automation](desktop/automation.md) · [Frame protocol](desktop/frame-protocol.md) · [Logging](desktop/logging.md) · [Localization](desktop/localization.md) · [Retro-Go builds](retrogo.md) · [SD assets](sdcard.md)

The legacy kernel is retired and `--kernel=legacy` is rejected. Historical machine parameters and acceptance reports describe the implementation at that time. Retired source references and reproduction notes are kept in [migration history](research/2026-11-13-gwemu-migration-history.md); the [migration completion report](research/2026-11-13-gwemu-migration-completion.md) records the current integration's provenance.
