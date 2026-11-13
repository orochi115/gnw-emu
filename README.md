# gnw-emu：Game & Watch（Zelda / Mario）模拟器

Electron 桌面使用固定版本的 [gwemu](https://github.com/orochi115/gwemu) 内核，运行 Mario/Zelda 原厂固件、Flash-only Retro-Go 和 SD Retro-Go。`.gnw.json` 配置指定内部 Flash、外部 Flash、可选 Bank 2/SD、接线和设备 UID；源镜像复制到独立 session 后运行，刷写和恢复不会写入原始 ROM。

原厂反复出现 PRESS TIME / 12:00 的 OSPI/CRYP 设置读取问题已修复。最新[设备差异与回归记录](docs/research/2026-11-13-gwemu-stock-settings-and-device-review.md)包含仍待修复的 Retro-Go 冷启动路径、背光及 NOR 等设备缺口。

[gnwmanager](https://github.com/orochi115/gnwmanager) 负责完整备份、校验、选择区域恢复、刷写、文件系统、截图、监视、GDB 调试及保护状态管理。桌面发布当前设备的本地会话入口；没有加载 ROM 时不启动模拟器，也没有常驻 daemon。

## 构建和启动

需要 Node.js 24、C/C++ 编译器、Python >= 3.11、Ninja、CMake、pkg-config、GLib、Pixman、libpng 和 liblzma。macOS 可使用 Homebrew 安装依赖。gwemu 首次配置还会下载固定的 upstream wrap 依赖。

```sh
git submodule update --init externals/gwemu externals/gnwmanager
scripts/build.sh
cd desktop
npm ci
npm run build
npm run dev
```

默认内核产物是 `build/gwemu/qemu-system-arm`。`scripts/build.sh` 委托独立 `build_gwemu.sh`，不注入旧机器源码或补丁；`gnw-build-manifest.json` 记录源码提交、配置、工具链和实际产物哈希。源码/配置变更时已有构建目录会被拒绝复用，可用 `GWEMU_BUILD_DIR` 指定新目录。源码和依赖来源可追溯，不承诺跨宿主的二进制字节完全一致。

也可从根目录执行：

```sh
scripts/run.sh zelda
scripts/run.sh mario
scripts/run.sh FILE.gnw.json
scripts/run_backup.sh BACKUP_DIR
SD_WIRING=spi1 scripts/run_sd.sh BACKUP_DIR
SD_WIRING=ospi scripts/run_sd.sh BACKUP_DIR
scripts/run_sd_update.sh BACKUP_DIR
PROFILE=FILE.gnw.json scripts/probe.sh 4
```

完整 dump 的 `bank1.bin`、`bank2.bin`、`ext.bin` 可继续作为输入资产。SD 直启、卡升级与核心构建见 [SD 文档](docs/sdcard.md)。Flash-only 和 SD 两种固件用途均保留；不提供 OpenOCD 模拟服务。

## 桌面和数据

“文件 → 加载 ROM…”加载已有配置，“制作 ROM…”组合已有镜像。键盘默认：方向键、X/Z 为 A/B，G/T/P/O 为 GAME/TIME/PAUSE/POWER，Return/Tab 为 START/SELECT，-/= 调整电量，C 切换 USB。可在“编辑 → 自定义按键…”配置键盘、软件手柄映射、连发和热键，见 [按键说明](docs/desktop/controls.md)。

设备菜单提供电池连接、USB、电量、暂停、继续和冷启动。插入 USB 后即使拔掉电池仍可供电；电池和 USB 都断开时设备失电。充放电周期按虚拟时间计算，暂停时停止计时。此为板级供电模型，不模拟真实电池曲线和充电器全部电气特性。

开发版数据默认位于项目 `UserData`，打包版使用系统应用数据目录；`--user-data-dir=PATH` 可覆盖。实际镜像、sidecar 和 session 信息位于 `UserData/kernels/gwemu/sessions/<profileId>`，设置/日志位于应用数据根目录。换 ROM 建立新的运行 UUID，正常关闭同步 session；崩溃或中断时明确报告保存不确定。

**不自动导入已经生成的 legacy UserData。** 新 gwemu session 首次从配置指定的原始镜像建立，之后保留自己的更改；旧 session、slots 和历史文件保留原处。此决定不影响 gnwmanager 对旧备份归档格式的支持。

即时存档使用 F5/F8 和 0–9 槽位，保存在 session 的 `states-gwemu` 内，记录当前实际运行二进制 SHA256，拒绝内核或 build 不匹配的状态。支持 CPU/RAM/外设及完整 Flash 回滚；SD 模式不支持，外部 Flash 上限 64 MiB。源镜像不参与写回。见 [存档说明](docs/desktop/savestates.md)。没有运行时快进/实时模式切换开关。

## 管理当前模拟设备

在 `externals/gnwmanager` 安装 Python 包后使用其公开 CLI：

```sh
python -m gnwmanager sessions
python -m gnwmanager --session UUID info
python -m gnwmanager --session UUID shell
python -m gnwmanager --help
```

CLI 默认按需发现当前桌面会话；多个活动设备必须明确选择 UUID，无设备时提示启动桌面并加载 ROM。外部实体设备仍可显式选择原有 backend。离线归档验证/获取不要求活动设备。完整命令与恢复权限见 [manager CLI 验收](docs/research/2026-11-13-gwemu-session-manager-cli.md)。

本地发现目录为 `/tmp/gnw-manager-<uid>`，私有 RPC 和 GDB 使用当前会话拥有的 socket。桌面保持 QMP 所有权；manager 的供电和按键通过桌面协调。管理或 GDB 接管期间，换 ROM、即时存档和冲突输入被门禁；客户端退出/崩溃、换 ROM 或 native 退出会撤销旧会话，操作不会自动转向新 ROM。中断报告部分完成或保存无法确认。

## 验证和打包

```sh
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu/qemu-system-arm" npm test
npm run typecheck
npm run package:dir
```

目录包包含 gwemu 和依赖库、原构建 manifest、重定位/签名后真实哈希的 package manifest，不带 ROM、SD 或用户数据。stage 拒绝缺失、dirty、非固定来源或哈希不匹配的 native。开发版与打包版均默认使用 gwemu，`--kernel=legacy` 明确拒绝。

原设计逐项验收与最终来源见[迁移完成报告](docs/research/2026-11-13-gwemu-migration-completion.md)，具体软件证据见[产品验收](docs/research/2026-11-13-gwemu-product-acceptance.md)和[真实桌面 manager 工作流](docs/research/2026-11-13-gwemu-session-manager.md)。实机（含 SD 改装机）和实体手柄验证按用户决定豁免，由用户后续进行；模拟器结果不构成实机兼容证明。Windows/Linux 包没有在此次 macOS 工作环境构建验收，不报告通过。

## 目录和历史

| 路径 | 用途 |
| --- | --- |
| `externals/gwemu` | 固定的 gwemu 集成源码 |
| `externals/gnwmanager` | 模拟器/实体设备管理与完整备份 |
| `desktop` | Electron 界面、profile/session、自动化、打包 |
| `harness`、`tests` | gwemu 与 manager 的软件验证夹具 |
| `scripts` | 内核/固件/核心构建、镜像制作和启动 |
| `docs` | 使用文档、设计及历史验收记录 |

旧 QEMU、机器实现及 backup fork 的固定引用和复现方式单独记录在 [迁移历史](docs/research/2026-11-13-gwemu-migration-history.md)。本机历史工作副本/build 和已有镜像/备份保留；历史报告中旧机器参数只描述当时的实现。
