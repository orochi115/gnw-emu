# Windows 原生构建与使用

支持 Windows 11 x64，PowerShell 5.1+。桌面端和 gwemu 为 Windows 原生进程；MSYS2 UCRT64 只用于构建。安装 Node.js 24+、Python 3.11+、Git for Windows，并确保 `node`、`python`、`git`、`curl.exe`、`tar.exe` 可用。建议使用无空格的工作目录。

本次部署目录为 `D:\LLM_Work\Game_Watch\gnw-emu`，工具链位于同级 `toolchains`。在 PowerShell 中：

```powershell
cd D:\LLM_Work\Game_Watch\gnw-emu
powershell -ExecutionPolicy Bypass -File scripts\windows\bootstrap.ps1 -CoreToolchain
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\run.ps1 -Profile profiles\windows-mario.gnw.json
```

`bootstrap.ps1` 初始化固定子模块，安装 MSYS2/GCC/CMake/Ninja、Python 工具和 Electron 依赖。默认使用清华 MSYS2 镜像，可用 `-Mirror` 修改。`-SkipArm` 只安装桌面端构建依赖；`-CoreToolchain` 额外安装 GCC 15.2。可设置 `GNW_TOOLCHAIN_ROOT` 覆盖同级工具链目录。

已有源码或编译配置改变时，内核构建脚本拒绝混用旧对象；保留旧目录并通过 `GWEMU_BUILD_DIR` 构建到新目录，或将旧 `build\gwemu` 改名后重新构建。`build.ps1` 的桌面端和打包流程支持同一自定义目录。本次部署的 `build\gwemu` 是指向最终干净构建 `build\gwemu-windows-final` 的目录联接，以保留 Meson 记录的绝对路径。

## 目录包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1 -Package
.\desktop\release\win-unpacked\gnw-emu.exe
```

目录包包含内核、递归收集的 MinGW DLL 和构建来源记录。整目录移动即可，运行无需 MSYS2、Python 或 Node.js。使用外部 `gnwmanager` CLI 时仍需下面的 Python 环境。包不附带 ROM 或用户数据，需用自己的备份创建 `.gnw.json` 或从界面打开已有配置。

打包要求 gwemu 工作树干净、提交与主仓库 HEAD 中固定的子模块提交一致、manifest 与二进制哈希一致。自定义内核需要先更新对应提交，不能跳过此检查。

## 固件、核心与 manager

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build-firmware.ps1 -Target manager
powershell -ExecutionPolicy Bypass -File scripts\windows\build-firmware.ps1 -Target retrogo-sd
powershell -ExecutionPolicy Bypass -File scripts\windows\build-cores.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\build-cores.ps1 -Cores fceumm,tgb-dual
.\build\windows-python\Scripts\python.exe -m gnwmanager sessions
.\build\windows-python\Scripts\python.exe -m gnwmanager --session SESSION_ID info
```

manager 和 Retro-Go 使用 ARM GCC 10.3，核心使用 ARM GCC 15.2。核心默认构建 LCD-Game-Emulator。固件生成只写工作目录中的构建产物；这些命令不向实体设备烧录。

Flash-only 使用明确的 ROM 选择清单和新输出目录：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build-firmware.ps1 -Target retrogo-flash -Output D:\LLM_Work\Game_Watch\flash-build -Assets D:\media -Selection D:\selection.json
```

清单格式、核心资源准备和双启动参数见 [Retro-Go 文档](../retrogo.md)。该包装命令提供 standalone 默认参数；更复杂参数可在 MSYS2 环境中调用 `scripts/build_retrogo_flash.py`，指定 Windows venv 和工具链。

Windows manager 使用当前用户专有 ACL 目录和带随机令牌的回环 TCP 会话，连接前核验监听进程 PID。每次 GDB 连接需验证令牌，未认证客户端无法暂停 CPU，闲置认证连接会超时。外部 GDB 通过 Python pipe adapter 连接；工具输出给出的完整 `target remote | ...` 命令可直接使用。

## 验证

```powershell
cd desktop
$env:GNW_TEST_FIRMWARE = 'D:\LLM_Work\Game_Watch\gnw-emu\local'
$env:GNWMANAGER_PYTHON = 'D:\LLM_Work\Game_Watch\gnw-emu\build\windows-python\Scripts\python.exe'
$env:GWEMU_WINDOWS_INTEGRATION = '1'
npm test
npm run test:e2e -- tests/e2e/windows-native.spec.ts
```

测试需要自己的 Mario/Zelda 备份；Windows 专有测试使用 `local` 下的 `internal_flash_backup_MODEL.bin` 和 `flash_backup_MODEL.bin`。不随源码分发 ROM。POSIX socket/inode/shebang 专有测试在 Windows 上排除，并由 Windows ACL、认证传输、实际 native manager 和 Electron 验证补充。实际验证范围与限制记录于 [验收报告](acceptance.md)。

SD 卡镜像可在 Windows 上用同一 Python 环境和 UCRT64 mtools 生成：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\make-sd-image.ps1 -Output out\sdcard.img -SizeMb 256 -WithUpdate
```

可加 `-Assets D:\media` 打包资源。包装脚本要求新输出路径；镜像中的文件由 mtools 读写，无需挂载或管理员权限。

本次修改和两个子模块提交保存在已部署仓库及工作目录中的 Git bundles 中，尚未推送到远端仓库。复制到另一台机器时需一并保留子模块仓库或先导入对应 bundles，随后再执行 bootstrap；仅从原上游地址重新 clone 无法取得这些本地移植提交。

完整源码 bundles 位于 `D:\LLM_Work\Game_Watch`。在包含这三个文件的目录中，可重建新的源码目录：

```powershell
git -c core.autocrlf=false clone --branch feat/windows-native gnw-emu-windows-source.bundle gnw-emu-copy
git -c core.autocrlf=false clone --branch gnw-emu gwemu-windows-source.bundle gnw-emu-copy\externals\gwemu
git -c core.autocrlf=false clone --branch gnw-emu-manager-ram gnwmanager-windows-source.bundle gnw-emu-copy\externals\gnwmanager
git -C gnw-emu-copy submodule absorbgitdirs externals/gwemu externals/gnwmanager
```

随后在新目录运行 bootstrap 初始化其余公开的固定依赖，并重新构建；构建目录不能直接搬移到不同路径。
