# gwemu 迁移实验

当前提供阶段一的隔离桌面开发预览，桌面默认仍使用旧 QEMU。gwemu 已接入持续帧、输入、静音、UID 和正常退出持久化；电源、完整即时存档和管理工具仍待验收。

## 来源与构建

- 上游：`slash-proc/gwemu`，`gnw-h7b0` 基线 `3bfce5fd26a402660a8526b3a7ffc92048c3966a`，gwemu v0.0.29 / QEMU 11.0.2。
- 集成仓库：[orochi115/gwemu](https://github.com/orochi115/gwemu)，桌面预览固定 `f74441159ccbe2fd265affbb03cd26f655addfe3`；首批基线为 `28936af4e4147f2b92514ee4b640022d00f75aa2`。
- 集成修复：初始化解锁 baseline 时只读取实际 NOR 容量，缺失尾部填 `0xff`；保留原 sidecar 长度。原来的 Zelda baseline 长度超过 Mario 1 MiB 映射，会阻塞初始化。
- `patches/gwemu/0001-limit-unlock-baseline-to-flash-capacity.patch` 是修复的审查副本，代码已在固定提交中；构建不向源码注入补丁。

需要 C/C++ 编译器、Python >= 3.11、Ninja、CMake、pkg-config、GLib、Pixman、libpng 和 liblzma。上游即使只做 headless 实验也会构建 SDL3/ImGui；首次配置会下载其 wrap 固定依赖。脚本在 QEMU 自有 `pyvenv` 安装固定 `PyYAML==6.0.3`，不改宿主 Python。

从仓库根目录运行：

```sh
git submodule sync -- externals/gwemu
git submodule update --init externals/gwemu
GWEMU_BUILD_DIR=build/gwemu-desktop sh scripts/build_gwemu.sh
```

默认输出为 `build/gwemu`；桌面开发入口固定读取 `build/gwemu-desktop`，首批基线目录 `build/gwemu-fork` 保留供对照。可用 `GWEMU_SRC`、`GWEMU_BUILD_DIR`、`GWEMU_PYTHON` 显式指定来源、目录和解释器。源码路径、revision、解释器或配置环境变化时，脚本拒绝复用已有输出目录，选择新目录重新构建。

`gnw-build-manifest.json` 记录实际 revision、tracked diff、dirty 状态、补丁审查副本哈希、配置参数、编译器/依赖版本、宿主信息和产物 SHA-256。它提供来源追溯；未固定宿主 SDK/系统库，而且上游版本标头包含构建时间，因此不承诺跨宿主或重复构建的二进制字节完全相同。

查询版本时使用 `-display none --version` 或上游识别的 `-version`。单独的 `--version` 会触发该版本的默认 GUI 入口。

## 隔离桌面预览

先按上文构建固定提交，再从 `desktop` 运行：

```sh
npm run build
GNW_KERNEL=gwemu npx electron . --user-data-dir=/tmp/gnw-gwemu-preview ../profiles/zelda.gnw.json
```

必须显式指定独立 `--user-data-dir=`，项目/系统产品 UserData、其祖先/子目录及符号链接别名均会在创建目录前拒绝。打包版本也拒绝该模式。配置和日志写入指定目录，镜像、lease 与原生 sidecar 写入其中的 `kernels/gwemu` 命名空间。GDB 默认关闭；子进程会清除宿主 `GNW_*`/`GWEMU_*` 自动化变量。

支持标准 QMP 差量按键、焦点丢失释放、运行时静音、换 ROM 与关闭。加载新 ROM 前检查容量、接线、UID 和二进制能力；不兼容配置会保留当前运行。原生锁在镜像初始化前取得，进程退出后释放。正常 exit0 后同步 session 镜像/sidecar 并写入元数据；崩溃或强制终止显示保存不确定。

即时存档菜单被禁用，热键和电源操作明确提示暂不支持；旧 slots 不读不写。音频后端已接通且静音有实际 PCM 证据，但音质、延迟、宿主实时限速设置、完整 RTC 和冷启动仍待回归。该入口只供开发验收，详细证据见 [桌面预览报告](../research/2026-11-12-gwemu-desktop-preview.md)。普通桌面 CLI 启动/探针仍使用旧内核，不能通过该环境变量切换。

## 同镜像实验

```sh
cd desktop
npm run build:cli
node dist-cli/compare-kernels.js \
  --profile ../profiles/mario.gnw.json \
  --legacy ../build/qemu-system-arm \
  --gwemu ../build/gwemu-desktop/qemu-system-arm \
  --output ../out/gwemu-my-mario-run \
  --seconds 3
```

输出目录必须不存在，其父目录必须存在。命令复用 `.gnw.json` 校验；每个内核各创建一份全新 session，所有镜像参数均绑定这些副本。它不接受既有 UserData，结束后保留实验副本和诊断。SD 也复制后挂载，两个副本需要相应磁盘空间。

报告包含运行前后的源与 session 镜像容量/哈希、两个内核产物版本与哈希、启动参数、QMP 接口清单、初始/结束寄存器、向量/UID/RTC 读回、gwemu GDB 能力应答、截图和错误。创建输出目录后，启动、复制或 session 哈希失败会记录失败阶段，并尽量完成源哈希复核。创建输出目录前的 profile/源文件/产物预检查失败仅返回 CLI 错误。进程使用本地 QMP 与短路径 GDB Unix socket；屏蔽宿主 `GNW_*`/`GWEMU_*` 自动化环境变量。关闭先发 QMP quit，必要时终止实验子进程。

`--seconds` 是墙钟观察时间，范围 `(0, 60]`。`--buttons left+game` 会在运行后 0.5 秒按住组合键 0.3 秒；两套内核用各自已有输入接口，报告记录该操作。它适合初步检查，不是按虚拟时间同步的游戏回归。两套内核可能在按键时处于不同启动阶段。

已支持容量：外部 Flash 1/4/8/16/32/64/128/256 MiB，按容量选择上游 Macronix 芯片；片内每个 bank 至多 256 KiB。较短 bank 在 gwemu session 内填 `0xff` 扩展，不修改源。显式 UID 按 `.gnw.json` 的 12 raw bytes 契约传入，缺省时保留上游合成 UID。OSPI SD 和未支持容量会明确拒绝。芯片选择只提供容量匹配，没有给 profile 新增真实 JEDEC 身份。

固定时间同时映射到 gwemu 自定义 RTC 的 `initial-epoch`，初始寄存器读回已验证；完整 RTC 用户流程仍需回归。实验关闭音频，不能据此宣称音频通过。

`captured` 只表示拿到观察数据，不能等同于固件、存档或管理工具全功能通过。失败或源哈希变化时 CLI 返回非零退出码。实测范围与后续缺口见 [基线报告](../research/2026-11-12-gwemu-baseline.md)。

## 回归检查

```sh
GWEMU_BINARY="$PWD/build/gwemu-desktop/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu.py tests/test_gwemu_desktop.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-desktop/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-desktop/qemu-system-arm" npm test
npm run typecheck
npm run build
npm run test:e2e -- tests/e2e/gwemu-preview.spec.ts
```

原生测试用合成 Flash 复现 1/4 MiB 初始化、sidecar 填充和原镜像保护。桌面测试另用合成循环固件实际核对逗号目录、向量加载、固定 RTC 和自动化环境隔离。缺少 gwemu 产物时后者会明确跳过；纯参数测试不替代这些原生证据。

本批次没有移除旧内核/backup，没有读取或覆盖产品 session/即时存档，没有实现阶段二备份迁移或阶段三当前会话发现。
