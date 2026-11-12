# gwemu 迁移实验

当前完成阶段一的构建与对照基线，桌面默认仍使用旧 QEMU。gwemu 尚未提供桌面所需的帧流、退出状态、电源和即时存档契约，不能通过直接替换桌面可执行文件完成接入。

## 来源与构建

- 上游：`slash-proc/gwemu`，`gnw-h7b0` 基线 `3bfce5fd26a402660a8526b3a7ffc92048c3966a`，gwemu v0.0.29 / QEMU 11.0.2。
- 集成仓库：[orochi115/gwemu](https://github.com/orochi115/gwemu)，固定 `28936af4e4147f2b92514ee4b640022d00f75aa2`。
- 集成修复：初始化解锁 baseline 时只读取实际 NOR 容量，缺失尾部填 `0xff`；保留原 sidecar 长度。原来的 Zelda baseline 长度超过 Mario 1 MiB 映射，会阻塞初始化。
- `patches/gwemu/0001-limit-unlock-baseline-to-flash-capacity.patch` 是修复的审查副本，代码已在固定提交中；构建不向源码注入补丁。

需要 C/C++ 编译器、Python >= 3.11、Ninja、CMake、pkg-config、GLib、Pixman、libpng 和 liblzma。上游即使只做 headless 实验也会构建 SDL3/ImGui；首次配置会下载其 wrap 固定依赖。脚本在 QEMU 自有 `pyvenv` 安装固定 `PyYAML==6.0.3`，不改宿主 Python。

从仓库根目录运行：

```sh
git submodule sync -- externals/gwemu
git submodule update --init externals/gwemu
GWEMU_BUILD_DIR=build/gwemu-fork sh scripts/build_gwemu.sh
```

默认输出为 `build/gwemu`；上面的独立目录用于保留迁移前后实验产物。可用 `GWEMU_SRC`、`GWEMU_BUILD_DIR`、`GWEMU_PYTHON` 显式指定来源、目录和解释器。源码路径、revision、解释器或配置环境变化时，脚本拒绝复用已有输出目录，选择新目录重新构建。

`gnw-build-manifest.json` 记录实际 revision、tracked diff、dirty 状态、补丁审查副本哈希、配置参数、编译器/依赖版本、宿主信息和产物 SHA-256。它提供来源追溯；未固定宿主 SDK/系统库，而且上游版本标头包含构建时间，因此不承诺跨宿主或重复构建的二进制字节完全相同。

查询版本时使用 `-display none --version` 或上游识别的 `-version`。单独的 `--version` 会触发该版本的默认 GUI 入口。

## 同镜像实验

```sh
cd desktop
npm run build:cli
node dist-cli/compare-kernels.js \
  --profile ../profiles/mario.gnw.json \
  --legacy ../build/qemu-system-arm \
  --gwemu ../build/gwemu-fork/qemu-system-arm \
  --output ../out/gwemu-my-mario-run \
  --seconds 3
```

输出目录必须不存在，其父目录必须存在。命令复用 `.gnw.json` 校验；每个内核各创建一份全新 session，所有镜像参数均绑定这些副本。它不接受既有 UserData，结束后保留实验副本和诊断。SD 也复制后挂载，两个副本需要相应磁盘空间。

报告包含运行前后的源与 session 镜像容量/哈希、两个内核产物版本与哈希、启动参数、QMP 接口清单、初始/结束寄存器、向量/UID/RTC 读回、gwemu GDB 能力应答、截图和错误。创建输出目录后，启动、复制或 session 哈希失败会记录失败阶段，并尽量完成源哈希复核。创建输出目录前的 profile/源文件/产物预检查失败仅返回 CLI 错误。进程使用本地 QMP 与短路径 GDB Unix socket；屏蔽宿主 `GNW_*`/`GWEMU_*` 自动化环境变量。关闭先发 QMP quit，必要时终止实验子进程。

`--seconds` 是墙钟观察时间，范围 `(0, 60]`。`--buttons left+game` 会在运行后 0.5 秒按住组合键 0.3 秒；两套内核用各自已有输入接口，报告记录该操作。它适合初步检查，不是按虚拟时间同步的游戏回归。两套内核可能在按键时处于不同启动阶段。

已支持容量：外部 Flash 1/4/8/16/32/64/128/256 MiB，按容量选择上游 Macronix 芯片；片内每个 bank 至多 256 KiB。较短 bank 在 gwemu session 内填 `0xff` 扩展，不修改源。OSPI SD、显式 UID 和未支持容量会明确拒绝。芯片选择只提供容量匹配，没有给 profile 新增真实 JEDEC 身份。

固定时间同时映射到 gwemu 自定义 RTC 的 `initial-epoch`，初始寄存器读回已验证；完整 RTC 用户流程仍需回归。实验关闭音频，不能据此宣称音频通过。

`captured` 只表示拿到观察数据，不能等同于固件、存档或管理工具全功能通过。失败或源哈希变化时 CLI 返回非零退出码。实测范围与后续缺口见 [基线报告](../research/2026-11-12-gwemu-baseline.md)。

## 回归检查

```sh
GWEMU_BINARY="$PWD/build/gwemu-fork/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-fork/qemu-system-arm" npm test
npm run typecheck
npm run build
```

原生测试用合成 Flash 复现 1/4 MiB 初始化、sidecar 填充和原镜像保护。桌面测试另用合成循环固件实际核对逗号目录、向量加载、固定 RTC 和自动化环境隔离。缺少 gwemu 产物时后者会明确跳过；纯参数测试不替代这些原生证据。

本批次没有移除旧内核/backup，没有读取或覆盖产品 session/即时存档，没有实现阶段二备份迁移或阶段三当前会话发现。
