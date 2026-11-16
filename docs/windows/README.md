# Windows 原生构建与使用

支持 Windows 11 x64，PowerShell 5.1+。桌面端和 gwemu 为 Windows 原生进程；MSYS2 UCRT64 只用于构建。安装 Node.js 24+、Python 3.11+、Git for Windows，并确保 `node`、`python`、`git`、`curl.exe`、`tar.exe` 可用。建议使用无空格的工作目录。

以下示例使用 `D:\Projects\gnw-emu`；请替换成自己的克隆目录。工具链默认位于同级 `toolchains`。

固件不随源码分发。通过“制作 ROM…”选择自己的 Mario/Zelda 镜像，保存为 `.gnw.json`。仓库自带的 `profiles\mario.gnw.json` 和 `profiles\zelda.gnw.json` 通过 `../../firmware` 引用备份；仅在这些路径存在时可直接使用。相对路径以配置文件所在目录为基准。

在 PowerShell 中：

```powershell
cd D:\Projects\gnw-emu
powershell -ExecutionPolicy Bypass -File scripts\windows\bootstrap.ps1 -CoreToolchain
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\run.ps1
```

`bootstrap.ps1` 初始化固定子模块，安装 MSYS2/GCC/CMake/Ninja、Python 工具和 Electron 依赖。默认使用清华 MSYS2 镜像，可用 `-Mirror` 修改。`-SkipArm` 只安装桌面端构建依赖；`-CoreToolchain` 额外安装 GCC 15.2。可设置 `GNW_TOOLCHAIN_ROOT` 覆盖同级工具链目录。

已有源码或编译配置改变时，内核构建脚本拒绝混用旧对象；保留旧目录并通过 `GWEMU_BUILD_DIR` 构建到新目录，或将旧 `build\gwemu` 改名后重新构建。`build.ps1` 的桌面端和打包流程支持同一自定义目录。构建目录记录绝对路径，不能直接搬移到不同位置继续使用。

## 目录包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1 -Package
.\desktop\release\win-unpacked\gnw-emu.exe
```

目录包包含内核、递归收集的 MinGW DLL 和构建来源记录。整目录移动即可，运行无需 MSYS2、Python 或 Node.js。使用外部 `gnwmanager` CLI 时仍需下面的 Python 环境。包不附带 ROM 或用户数据，需用自己的备份创建 `.gnw.json` 或从界面打开已有配置。

运行时的应用、配置、镜像、会话和存档路径支持中文、emoji 和空格。Windows 内核使用 Unicode 参数和文件 API；无需改变系统区域设置。内核更新后，旧快捷存档因二进制哈希绑定而无法载入，更新本身不会删除旧文件。游戏自身保存数据与快捷存档分开存放，仍使用原 profile 的会话目录；需要载入旧快捷存档时请保留旧包及 UserData 备份。

可把一个 `.gnw.json` 配置从资源管理器拖入主窗口打开，也可在游戏运行时拖入配置切换。拖入无效配置或 `.bin` 固件会显示错误并保留当前游戏；制作 ROM 或设置对话框打开时需先关闭对话框。

打包要求 gwemu 工作树干净、提交与主仓库 HEAD 中固定的子模块提交一致、manifest 与二进制哈希一致。自定义内核需要先更新对应提交，不能跳过此检查。

## 绿色 portable 包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1 -Portable
```

生成 `desktop\release\portable\gnw-emu-0.1.0-win-x64-portable.zip`。解压整个 ZIP 后运行 `gnw-emu.exe`，无需安装。也可在已经构建内核的 `desktop` 目录运行 `npm run package:portable`，复用现有内核打包。

包内 `portable.txt` 必须与 EXE 同目录；设置、存档、日志和 Electron 缓存写入旁边的 `UserData`。搬移时保留整个目录即可。普通目录包继续使用 `%APPDATA%\gnw-emu-desktop\UserData`；可通过 `--portable` 临时启用相邻数据目录，显式 `--user-data-dir=路径` 优先于 portable。已有普通版数据可在完全退出后将其 UserData 复制到 portable 目录下。构建前会检查输出目录中的 `UserData`，若已存在则停止，避免 electron-builder 清空使用过的绿色版数据。此时将整份已使用的程序移到独立目录，或用 `--config.directories.output=新目录` 打包。固件和 profile 仍需另行准备，配置引用路径以 profile 所在位置为基准。

## Windows 菜单和桌面时钟

Windows 普通模式在标题栏中横向显示文件、设备、编辑、设置、视图和窗口菜单；空间不足时自动折叠为三线按钮。标题栏文字由应用绘制，下拉菜单及时钟右键菜单使用 Win32 `HMENU`，保留中文、勾选、禁用状态及快捷键提示。时钟右键菜单提供返回普通模式、停靠、边框、静音、窗口透明度、倍率和退出；设备及即时存档操作仍在普通模式提供。透明度 20–100% 会持久化，返回普通模式恢复完全不透明。

时钟窗口可覆盖任务栏且不抢焦点，停靠、吸附和移动极限使用完整显示器边界。自由拖动过程中和松手后都保持窗口位于对应显示器内；支持移到另一显示器，超出边界会退回。释放时距边缘 24 个逻辑像素以内自动吸附，没有额外停靠间距。缩放、边框切换或屏幕变化后会修正位置，必要时降到可显示的倍率。正常窗口移动不受此限制。

时钟左上角返回/关闭按钮只在鼠标悬停该区域或键盘聚焦时显示，按钮随小窗口缩小。双击时钟不会最大化。机身游戏按键没有单独焦点系统，仍支持鼠标及配置的键盘映射。

构建普通包和 portable ZIP 后，在已解锁的 Session 1 桌面从 `desktop` 目录运行 `npm run test:windows-clock` 可重复验收。它操作真实鼠标，使用临时数据和 ZIP 副本，验证横向菜单与窄窗口折叠、反复拖动后窗口/客户区尺寸不变、时钟交互及搬移重启；请在测试期间留出鼠标操作权。默认加载 `profiles/zelda.gnw.json`，可通过 `GNW_TEST_PROFILE` 指定自己的 Zelda 配置；`GNW_TEST_PACKAGE_DIR` 和 `GNW_TEST_PORTABLE_ZIP` 可指定待验收包。结果写入 `out/windows-clock-portable-result.json`。

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
powershell -ExecutionPolicy Bypass -File scripts\windows\build-firmware.ps1 -Target retrogo-flash -Output D:\Projects\flash-build -Assets D:\media -Selection D:\selection.json
```

清单格式、核心资源准备和双启动参数见 [Retro-Go 文档](../retrogo.md)。该包装命令提供 standalone 默认参数；更复杂参数可在 MSYS2 环境中调用 `scripts/build_retrogo_flash.py`，指定 Windows venv 和工具链。

Windows manager 使用当前用户专有 ACL 目录和带随机令牌的回环 TCP 会话，连接前核验监听进程 PID。每次 GDB 连接需验证令牌，未认证客户端无法暂停 CPU，闲置认证连接会超时。外部 GDB 通过 Python pipe adapter 连接；工具输出给出的完整 `target remote | ...` 命令可直接使用。

## 验证

```powershell
cd desktop
$env:GNW_TEST_FIRMWARE = 'D:\Projects\gnw-emu\local'
$env:GNWMANAGER_PYTHON = 'D:\Projects\gnw-emu\build\windows-python\Scripts\python.exe'
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

移植源码使用主仓库 `master` 分支；修改过的 gwemu 和 gnwmanager 子模块使用各自 fork 的 `gnw-emu` 分支，具体提交由主仓库固定。可从 GitHub 获取完整源码：

```powershell
git -c core.autocrlf=false clone --branch master --recurse-submodules https://github.com/orochi115/gnw-emu.git
```

随后在项目目录运行 bootstrap。
