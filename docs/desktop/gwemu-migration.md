# gwemu 迁移实验

当前提供阶段一的隔离桌面开发预览，桌面默认仍使用旧 QEMU。gwemu 已接入持续帧、输入、静音、UID、电量/USB 控制和正常退出持久化。电池连接状态、断电 session、暂停/继续/冷启动，以及 host/fixed RTC、固件校时及暖复位保留已验收。完整即时存档已通过原生、桌面与 Electron 验收。RAM 管理固件的实际 Flash、HASH、恢复启动及两种 SD 接线已通过规格和质量审查；桌面现在使用包含 SPI 接收队列修复的干净产物，关闭记录见 [RAM 管理固件报告](../research/2026-11-12-gwemu-manager-ram.md)。完整工具链尚未验收。

## 来源与构建

- 上游：`slash-proc/gwemu`，`gnw-h7b0` 基线 `3bfce5fd26a402660a8526b3a7ffc92048c3966a`，gwemu v0.0.29 / QEMU 11.0.2。
- 集成仓库：[orochi115/gwemu](https://github.com/orochi115/gwemu)，当前 RAM 管理固件修复产物固定 `ae00b68951ab44b0dffb265e3f61340d735a68e5`，已公开发布并核对远程完整 SHA；此前已发布的存档产物为 `830192d221a70f2dff5fc466ac5d3c3c74bca584`，RTC 产物为 `60c313344b2747cb99a64bedfe958295bb575d11`；此前软件 SPI、冷循环和供电批次来源见对应研究报告。首批基线为 `28936af4e4147f2b92514ee4b640022d00f75aa2`。
- 集成修复：初始化解锁 baseline 时只读取实际 NOR 容量，缺失尾部填 `0xff`；保留原 sidecar 长度。原来的 Zelda baseline 长度超过 Mario 1 MiB 映射，会阻塞初始化。
- `patches/gwemu/0001-limit-unlock-baseline-to-flash-capacity.patch` 是修复的审查副本，代码已在固定提交中；构建不向源码注入补丁。

需要 C/C++ 编译器、Python >= 3.11、Ninja、CMake、pkg-config、GLib、Pixman、libpng 和 liblzma。上游即使只做 headless 实验也会构建 SDL3/ImGui；首次配置会下载其 wrap 固定依赖。脚本在 QEMU 自有 `pyvenv` 安装固定 `PyYAML==6.0.3`，不改宿主 Python。

从仓库根目录运行：

```sh
git submodule sync -- externals/gwemu
git submodule update --init externals/gwemu
GWEMU_BUILD_DIR=build/gwemu-manager-ram sh scripts/build_gwemu.sh
```

默认输出为 `build/gwemu`；桌面开发入口固定读取 `build/gwemu-manager-ram`，此前产物保留供对照。可用 `GWEMU_SRC`、`GWEMU_BUILD_DIR`、`GWEMU_PYTHON` 显式指定来源、目录和解释器。源码路径、revision、解释器或配置环境变化时，脚本拒绝复用已有输出目录，选择新目录重新构建。

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

电量/USB 复用现有热键（默认 - / = 调整电量，C 切换 USB）和隔离 session 的电量/充放电周期配置。「设备」菜单另提供电池连接、暂停、继续、冷启动；时钟窗口菜单同样支持。周期以虚拟时间计算，暂停时不消耗；0 周期固定相应状态。正常关闭先等待电源操作、暂停并严格读回电量/USB/电池存在，退出0且同步文件后再保存；读回失败或操作队列超时仍终止子进程并标记保存不确定。

该板级模型使用 Retro-Go 标尺 11000..13000、PA2 PGOOD 与 PE7 CHG；0% 不代表物理断开或电源域失电，真实曲线与充电器 CE 限流未建模。上游原生默认不开启此模型，桌面显式传入 power-model=on。即时存档开发实现使用独立 states-gwemu 格式和实际产物 SHA 检查，旧 slots 不读不写；本批验收后仍保留 legacy 默认，管理工具等阶段一退出条件尚未满足。详见 [电量与 USB 实测报告](../research/2026-11-12-gwemu-power-controls.md)。音频后端已接通且静音有实际 PCM 证据，但音质、延迟、宿主实时限速设置仍需更广泛固件回归，RTC 基础语义已验收。该入口只供开发验收，详细证据见 [桌面预览报告](../research/2026-11-12-gwemu-desktop-preview.md)。普通桌面 CLI 启动/探针仍使用旧内核，不能通过该环境变量切换。

## 同镜像实验

```sh
cd desktop
npm run build:cli
node dist-cli/compare-kernels.js \
  --profile ../profiles/mario.gnw.json \
  --legacy ../build/qemu-system-arm \
  --gwemu ../build/gwemu-manager-ram/qemu-system-arm \
  --output ../out/gwemu-my-mario-run \
  --seconds 3
```

输出目录必须不存在，其父目录必须存在。命令复用 `.gnw.json` 校验；每个内核各创建一份全新 session，所有镜像参数均绑定这些副本。它不接受既有 UserData，结束后保留实验副本和诊断。SD 也复制后挂载，两个副本需要相应磁盘空间。

报告包含运行前后的源与 session 镜像容量/哈希、两个内核产物版本与哈希、启动参数、QMP 接口清单、初始/结束寄存器、向量/UID/RTC 读回、gwemu GDB 能力应答、截图和错误。创建输出目录后，启动、复制或 session 哈希失败会记录失败阶段，并尽量完成源哈希复核。创建输出目录前的 profile/源文件/产物预检查失败仅返回 CLI 错误。进程使用本地 QMP 与短路径 GDB Unix socket；屏蔽宿主 `GNW_*`/`GWEMU_*` 自动化环境变量。关闭先发 QMP quit，必要时终止实验子进程。

`--seconds` 是墙钟观察时间，范围 `(0, 60]`。`--buttons left+game` 会在运行后 0.5 秒按住组合键 0.3 秒；两套内核用各自已有输入接口，报告记录该操作。它适合初步检查，不是按虚拟时间同步的游戏回归。两套内核可能在按键时处于不同启动阶段。

已支持容量：外部 Flash 1/4/8/16/32/64/128/256 MiB，按容量选择上游 Macronix 芯片；片内每个 bank 至多 256 KiB。较短 bank 在 gwemu session 内填 `0xff` 扩展，不修改源。显式 UID 按 `.gnw.json` 的 12 raw bytes 契约传入，缺省时保留上游合成 UID。SD 支持 `spi1`（缺省）和 `ospi`。后者为 PB2/PB1/PD12/PE11 的 GPIO 软件 SPI 接线；未支持容量会明确拒绝。芯片选择只提供容量匹配，没有给 profile 新增真实 JEDEC 身份。

固定时间同时映射到 gwemu 自定义 RTC 的 `initial-epoch`，日历/SSR、暂停、校时与复位读回已验证；详见下文 RTC 验收。实验关闭音频，不能据此宣称音频通过。

`captured` 只表示拿到观察数据，不能等同于固件、存档或管理工具全功能通过。失败或源哈希变化时 CLI 返回非零退出码。实测范围与后续缺口见 [基线报告](../research/2026-11-12-gwemu-baseline.md)。

## 回归检查

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu.py tests/test_gwemu_desktop.py tests/test_gwemu_power.py tests/test_gwemu_softspi.py tests/test_gwemu_supply.py tests/test_gwemu_rtc.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" npm test
npm run typecheck
npm run build
npm run test:e2e -- tests/e2e/gwemu-preview.spec.ts tests/e2e/gwemu-supply.spec.ts
```

原生测试用合成 Flash 复现 1/4 MiB 初始化、sidecar 填充和原镜像保护。桌面测试另用合成循环固件实际核对逗号目录、向量加载、固定 RTC 和自动化环境隔离。缺少 gwemu 产物时后者会明确跳过；纯参数测试不替代这些原生证据。

本批次没有移除旧内核/backup，没有读取或覆盖产品 session/即时存档，没有实现阶段二备份迁移或阶段三当前会话发现。

本地固件电源验收可从仓库根运行：

```sh
GNW_FIRMWARE_POWER_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-softspi/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_power_firmware.py
```

该检查需要本地 Mario/Zelda ROM、out/profiles 中的 Flash-only/SD profile 及原始镜像；缺少时显式跳过。所有挂载镜像均复制到临时目录（SD需要约1 GiB空间），核对源哈希，截图和 MMIO 证据写入 out/gwemu-softspi-controls/firmware。它验证板级输入，不代替真实供电、游戏回归或管理工具验收。

## 软件 SPI SD 验收

桌面将 `.gnw.json` 的 `sdWiring` 映射为 startup-only `sd-wiring=spi1|ospi`，SD 后端始终绑定当前隔离 session 的卡镜像。软件模式复用上游 SSI SD/Card，SPI1 不同时消费卡数据；原生缺省 SPI1 保留现有 CS/供电行为。旧构建缺少 `sd-wiring` 能力时，在停止活动 ROM 前拒绝加载。

```sh
GNW_FIRMWARE_SD_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-softspi/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_softspi_firmware.py
cd desktop
npm run test:e2e -- tests/e2e/gwemu-preview.spec.ts tests/e2e/gwemu-sd.spec.ts
```

本地固件验收需要 SD profile、对应 ELF/nm 和 mtools；所有镜像先复制，检查挂载标志、接线类型、NES core 身份和固件保存文件，并核对源镜像哈希。原生协议测试和桌面会话测试另覆盖块写入/停止/重开。GPIO 桥增加一字节响应延迟，保留普通字节边界 CS 间隔的待发响应；部分字节取消不保证任意中途命令恢复。真实卡供电仍未验收；后续 manager SD API 验证见下文 RAM 管理固件批次；桌面完整即时存档已完成后续验收。详见 [SD 接线实测报告](../research/2026-11-12-gwemu-softspi-sd.md)。

## 原生冷循环验收

后续原生提交补强 `gnw-cold-cycle` 的 ITCM 启动 seed 和 TAMP 备份域清除。该批独立验证产物位于 `build/gwemu-cold-cycle`；当时桌面仍固定 `build/gwemu-softspi`，未新增桌面冷启动操作或电池断开功能。

```sh
GNW_FIRMWARE_COLD_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-cold-cycle/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_cold_firmware.py
```

该检查只挂载本地 profile 的临时副本，复核源哈希。每类固件运行后重复两轮冷循环，确认 LTDC 经关闭后重新启用；Retro-Go 必须重新交接到 bank2。清除备份域后，patched OFW 需要先完成 PRESS TIME 画面再用 Left+GAME 进入 Retro-Go。实际供电、RTC/VBAT 和保护转换仍待验收，详见 [冷循环报告](../research/2026-11-12-gwemu-cold-cycle.md)。

## 原生电池存在与执行门禁

后续原生批次为 opt-in 电源模型增加 `battery-present` 和只读 `powered`。电池或 USB 任一存在即可运行；两者都断开则停机并拒绝 QMP/HMP/GDB 执行。恢复供电后保持暂停，显式继续才冷启动。电量 0% 不表示拔掉电池，真实电气截止和 RTC/VBAT 仍未实现。

```sh
GNW_FIRMWARE_COLD_TEST=1 GNW_FIRMWARE_SUPPLY_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-supply/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_cold_firmware.py
```

该原生批次只交付模型能力，验证产物为 `build/gwemu-supply`；当时桌面尚未使用这些新接口。断电/恢复、两种 SD 接线的退出重开、源镜像安全及范围限制见 [供电报告](../research/2026-11-12-gwemu-supply.md)。

## 桌面供电与冷启动

供电批次曾将桌面开发入口切换到 supply 产物，当前使用包含后续 RTC 与存档修复的 savestate 产物。「设备」菜单提供电池连接、USB 供电、暂停、继续和冷启动，时钟窗口同样可操作。拔掉最后来源进入无电源状态；接回来源保持暂停，选择继续才执行。冷启动会等待 host-ui RESET 及主循环确认后运行，不用固定延时猜测复位完成。

gwemu 隔离 session 保存 `batteryPresent`，旧元数据缺省 true，legacy session 格式不变。无电源关闭重开时可正常加载控制连接，不执行 cont 或等待画面。设备操作和暂停/断电时禁用硬件按键，已持有/连发输入需先松开再按；供电热键仍可使用。读取未知状态时禁用继续/冷启动并提示连接问题。

```sh
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" npm test
npm run typecheck
npm run build
npm run test:e2e -- tests/e2e/gwemu-supply.spec.ts tests/e2e/gwemu-preview.spec.ts tests/e2e/gwemu-sd.spec.ts tests/e2e/automation-ui.spec.ts tests/e2e/main-window.spec.ts
```

测试只挂载临时 session 副本，异常退出/快照错误/操作队列超时均不得声称保存成功；关闭和启动取消竞态另有真实内核回归。详见 [桌面供电报告](../research/2026-11-12-gwemu-desktop-supply.md)。默认仍为 legacy；完整即时存档及 RTC 恢复的原生验收已通过，桌面验收已通过，管理工具仍待完成。

## RTC 验收

桌面显式开启 RTC `use-rtc-clock`、`preserve-calendar`，关闭 `sync-host` 写入抑制。host 模式按宿主本地时间推进，CPU 暂停时 RTC/闹钟继续；固定 UTC 模式按虚拟时间推进，暂停冻结。普通复位保留当前日历，控制寄存器/闹钟仍复位。固件 INIT 校时冻结日历并在退出时一次提交 TR/DR，独立 wakeup 计数器继续。

完整冷启动、最后供电来源丢失/恢复和 BDRST 清除日历并重新初始化。USB 供电下拔电池不会清除 RTC。固件执行后可自行校时：两组 patched OFW 在备份丢失后设置 2021-01-01 12:00，模型允许该写入。session.rtc 是启动配置，固定 session 重开回到配置初值，host 重开从当前宿主时间开始。未模拟物理 VBAT、振荡器停振或掉电后的 RTC 能量来源。

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_rtc.py
GNW_FIRMWARE_RTC_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_rtc_firmware.py
```

后者需要四组本地镜像，始终挂载副本并在 finally 检查源哈希。gwemu 验收 Retro-Go bank2，legacy 对照沿用既有 OFW 入口；启动后执行忠实 INIT 校时序列，不声称已自动操作固件的整个校时 UI。旧 supply 产物缺少新 RTC 属性时，QEMU 明确拒绝启动。默认内核仍为 legacy；后续存档批次已补齐 RTC 恢复，具体 RTC 基础证据与边界见 [RTC 报告](../research/2026-11-12-gwemu-rtc.md)。

## 完整即时存档

当前产物保留完整的文件映射 Flash、供电/启动控制、RTC、JPEG、LTDC、OTFDEC 和 SAI 恢复，并增加 SPI 接收队列状态。gwemu 使用 `states-gwemu/` v2 和实际可执行文件 SHA；legacy `states/` v1 保留，不能跨内核或跨构建读取。读取回退当前 session 的完整 Flash，源 ROM 保持不变。无 SD、外部 Flash 不超过 64 MiB 和默认非 timing 模式的边界保留。

暂停/无电源读取不会发宿主按键事件，也不会自动继续。恢复失败后的临时恢复点保留；无法回滚或设备状态未知时禁止继续，关闭清理进程并报告保存不确定。规范及质量审查已经通过，桌面全套 217 项通过，typecheck/build 通过；七组真实 Electron 回归通过，包含暂停/断电 F5/F8 和 USB 热键；最终实现复审已通过。

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_savestate.py tests/test_gwemu_savestate_runtime.py tests/test_gwemu_savestate_peripherals.py
GNW_FIRMWARE_STATE_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_savestate_firmware.py
cd desktop
npm run test:e2e -- tests/e2e/gwemu-savestates.spec.ts tests/e2e/gwemu-supply.spec.ts tests/e2e/gwemu-preview.spec.ts tests/e2e/gwemu-sd.spec.ts tests/e2e/automation-ui.spec.ts tests/e2e/main-window.spec.ts tests/e2e/savestates.spec.ts
```

详细来源、原生真实固件验证及 NOR 模型限制见 [存档验收报告](../research/2026-11-12-gwemu-savestate.md)，用户操作与失败恢复见 [即时存档](savestates.md)。后续 gnwmanager RAM 固件、Flash 与 SD 的实际验证见 [RAM 管理固件报告](../research/2026-11-12-gwemu-manager-ram.md)。工具链全流程尚未验收，默认内核和旧仓库退出条件不变。

## RAM 管理固件验收

使用实际 gnwmanager/GDBBackend 和源码构建 RAM 固件，在合成1/4/64 MiB及Mario/Zelda/Flash-only Retro-Go副本上验证 IDLE、容量、HASH、三个Flash bank擦写和恢复启动。拒绝越界请求发生在邮箱提交前；内部program按8192-byte扇区，显式whole-chip语义保留。两种SD接线实际列目录、写入/读回270336-byte分块文件、重开校验和删除，另用独立FAT工具核对持久化。

本轮必要修复分别是manager寄存器/传输和范围验证、软件SPI读驱动逐块CRC/token处理、宿主保存目录错误，以及原生SPI1有界16-byte接收FIFO、数量/消费/IRQ恢复及VMState版本兼容。实际 Retro-Go 缓存 SR 后先写下一字节的行为需要保留未读字节顺序；没有用模拟器虚假等待字节迎合错误驱动。最终干净产物原生169项、copied真实固件26项（含供电输入复验）、manager及父harness197项通过，另有1项既有可选fixture跳过。桌面切换到新产物后，供电/存档能力预检、217项桌面测试、typecheck/build和七组实际Electron回归全部通过。此前savestate产物保留用于对照，不覆盖旧产物或槽位。

验收入口只连接显式创建的临时实例，不能发现或接管当前产品会话。Flash完整操作含应用观察受父进程180秒总期限，SD每个完整API阶段240秒；timeout或错误仍清理worker/native并检查源哈希。专用构建/Python环境、命令、候选SHA和范围限制见上述报告。备份迁移、UI会话入口、调试器交接及RDP/选项字节保护转换仍属于后续工作。
