# GNW 工具链离线 ROM profile 支持评估

日期：2026-11-11。依据本工作区源码与已有文档；没有执行刷机、编译或新的模拟器兼容性测试。结论针对本地版本，不能视为五个上游项目已支持这些能力。

**2026-11-12 更新：** 进一步核对公开上游，sylverb 推荐的 Flash-only `filesystem_wip` 已统一用 gnwmanager 刷写、擦除、格式化、存档管理，RESET_DBGMCU 也变为 `-- disable-debug`，不存在本地旧分支的 OpenOCD 尾调用。本文此前“传统 Retro-Go 需要兼容旧 OpenOCD”的结论只适用于工作区旧分支及保留历史脚本的范围，不能推广到当前推荐版。当前用户目标可以收敛为 gnwmanager 整合完整备份、连接 UI 当前 QEMU，以及 QEMU 补齐保护/电源等模型；独立 daemon 和 OpenOCD 语法兼容都不是第一阶段必需。

## 结论与范围

有意义：统一把备份、补丁、传统 Retro-Go、SD Retro-Go 转成可直接启动的机器镜像包，能减少实机调试依赖，支持安装预演、可重复回归和分享自制固件配置。推荐先完成离线产物互通，再做 gnwmanager 对运行中模拟器的管理。

“脱离实机”应拆成三个层次：

1. 不接设备即可从已有备份/源码构建 profile。价值高、改造可控。
2. 用模拟器执行刷写、文件管理和启动流程。价值高，但需 runtime 管理和端到端验证。
3. 完整替代真实设备的首次提取、RDP 解锁、选项字节与电气验证。不是当前 profile 能解决的目标。模拟器没有原始固件就无法凭空提取；开源 Retro-Go/独立 bootloader 可以不依赖原厂固件。

profile 应留在宿主工具层。STM32 上的固件继续消费 BIN、文件系统和 SD 内容，无须在固件中解析 .gnw.json。

### 澄清：运行兼容与原生 profile 支持

上述工期针对统一产品入口、导出、身份/锁、回归的完整工作，不意味着所有项目都要改算法。patch 和两种 Retro-Go 的离线构建核心可以保持原样，由外部适配器组装 profile。现有通过 GNWMANAGER 变量调用的刷写目标，可在核对参数覆盖与依赖后，把命令切换到 gnwmanager --backend gdb；这条路径可能只需配置和模拟器兼容性修正。每个项目原生命令直接接受 .gnw.json 时才需要增加薄入口。

不建议仿制完整 OpenOCD 来统一离线镜像与虚拟 STM32。镜像工具直接提供区域读写/组装/文件系统操作；运行中目标使用现有 GDB 后端执行 RAM 管理固件，QMP 管生命周期。原始 OpenOCD Tcl 脚本依赖 Flash 驱动、适配器配置与保护流程，需要专门移植或有限兼容桥，GDB 端口并非直接替换 OpenOCD 命令。纯镜像后端不能执行 RAM payload、读取实时 RAM 或验证解锁流程。

### 用户目标进一步明确：保留现有项目调用方式

如果目标是让现有项目通过环境变量选择虚拟设备，而非各项目原生生成/解析 profile，集中修改 gnwmanager、backup 和 gnw-emu 是可行架构。前述“不建议仿制完整 OpenOCD”不应被理解为反对有限 OpenOCD 兼容入口。

具体可在 gnw-emu 工具中提供 openocd-compat：支持本工作区实际调用的 -f/-c/-v、Tcl 语义及有限 target 命令，通过 GDB/QMP/明确的 Flash 操作服务实现。这不是重写完整 OpenOCD，也不是在镜像上伪造全部运行行为。旧 Retro-Go 直接调用的 program、flash erase_address、load/dump_image、mdw/mww、reg、halt/resume/reset，以及 :4444/:3333 服务路径应按范围提供。adapter 配置可在虚拟模式替换；对副作用及不支持的命令明确报错。Tcl 的 proc/foreach/expr/命令替换等应复用解释器或结构化实现，不能仅用分号切割。

gnwmanager 的 OpenOCDBackend 确实主要通过 0x1a 分帧的 Tcl socket 做内存、寄存器与执行控制；复杂的 Flash 操作多数由其 RAM 管理固件执行。旧版 flashapp.sh 也是写 RAM 控制变量并轮询目标执行。复杂性没有消失，但在 QEMU 中可由虚拟 STM32 执行，不需要每个上层项目修改。

gnw-emu/harness/gnw.py 已直接 subprocess.Popen qemu-system-arm，默认 -display none，接 QMP，无 Electron 依赖。共同的 profile target 服务需维持跨 OpenOCD/gnwmanager 调用的 QEMU、RAM 与执行状态；退出一次客户端不等于关闭虚拟机器。Flash 操作必须同步 QEMU 内存、raw Flash、XIP 视图和持久化文件，不能在 VM 运行中直接覆盖 backing file。

原 backup 解锁涉及 RDP、选项字节、断电及 payload；集中改造可添加虚拟语义并自动化按键/电源步骤。当前 gnw_flash 固定 RDP0，完整软件流程支持需补模拟状态，不能直接宣布现有 QEMU 已全功能。电气、焊接、探针速度这些实物属性不属于软件命令功能等价。

### 常驻方案选择

五个项目均存在硬件操作路径，差别是直接调用 OpenOCD，还是通过 gnwmanager 间接操作。patch 和 SD Retro-Go 的构建是离线的，但 flash 等目标会调用 gnwmanager。推荐混合接入：gnwmanager 原生 GDB 后端，旧脚本有限 OpenOCD facade，共享同一个 profile runtime。

keep alive 的首选是独立 headless daemon 管理持续存在的 QEMU 子进程，通过本地 socket 接入；命令完成后断开客户端，不终止或自动复位虚拟机。savestate 用于主动休眠/恢复，不作为跨短命令维持状态的机制。目前 savestate 不支持 SD，且外部 Flash 超过64MiB会拒绝，不能用于通用常驻替代。

UI socket 是可选接入形式而非必要依赖。长期可把 UI 的 SessionController 后端拆出到服务，UI 与 CLI 都作为客户端；当前 UI 自己启动并拥有 QEMU、lease 和 QMP，尚不能直接附着到已有 headless VM。近期只做命令行可先添加服务并与 UI 共享介质锁，禁止同时启动；需要同时观察同一虚拟设备时再补显示/输入接入。多工具连接需在整个管理流程上互斥，不能仅串行单次内存请求。

### Backend 能力与统一服务协议（后续问答）

GDBBackend 已覆盖基础内存访问、有限寄存器访问和 halt/resume/reset。明确缺口是 start_gdbserver 抛 NotImplementedError，导致现有 gdb/gdbserver 命令不可直接用；需处理后端释放与外部 GDB 独占接管。寄存器映射硬编码 r0-r15/xpsr，msp 是 r13 别名，没有独立 MSP/PSP/CONTROL 等完整 Cortex-M 寄存器解析；应读取目标 XML 并核对 ARM 栈指针语义。open() 总是 resume、reset_and_halt 先运行再停，需审计连接时状态保留、复位停机的确定性，以及响应校验/异常处理。探针频率对模拟器可无操作。lock/unlock 的缺口主要是 QEMU 保护/供电模型，不是 TCP 数据传输本身。

backup 的 read_internal.tcl 是无复位低层读取；现有 gnwmanager dump 会先 start_gnwmanager（复位并装载 RAM 固件），还用 Flash 地址校验器，因此不能直接替代 ITCM/RAM/选项字节读取。gnwmanager 需公开纯低层 read/write/reg/halt/resume/reset（不启动管理固件）的 API/CLI。传统 Retro-Go flashapp 流程可由该低层 API 保留原算法，或改用高层 flash；后者并不测试旧 flashapp 本身。若传统 Retro-Go 源码必须保持原样，仍需 OpenOCD 调用兼容前端；前端可由 gnwmanager 提供并使用相同核心，不必做第二套后端。若允许迁移这些脚本则可移除兼容入口。

UI 当前主进程监听 loopback TCP QMP，QEMU 作为客户端反向连接；帧由 QEMU 连向 utility 的 loopback TCP 接收器，走 Hello/ACK/二进制帧；utility 与 renderer 通过 Electron MessagePort；输入、电量、USB 通过 QMP QOM 属性；音频由 QEMU 本机播放。无通用外部设备 socket。统一服务可复用 QMP/GDB/帧协议，新增 Unix socket（Windows named pipe 或 loopback）的服务控制/发现/lease RPC；不必把像素或 GDB RSP 转成 JSON。

一个默认本地服务 socket 可以让 gnwmanager 不再接收 profile 路径：UI 或 headless 启动服务时加载 profile，工具只请求当前设备并显示其身份。无服务时提示启动 UI 并加载 ROM；服务存在但无设备、多个设备、管理操作中切换 ROM均需显式处理。管理 lease 锁定目标和 runtimeSessionId，UI 电源/按键操作可在流程允许时继续，ROM 切换和第二个管理操作被阻止。

UI 的电量与 USB 属性目前不等于完整电源模型。需要 batteryConnected、USB present、实际 powered 状态与真正的冷断电/上电过程（或等价明确接口），包括 RAM/外设复位与持久化 Flash 保留、backup所需按键时序。统一服务负责保持 QEMU 控制进程可连接，即使虚拟目标处于断电状态。

### 功能去重与当前 UI 生命周期

gnwmanager unlock 已把原始 backup 1–5 的核心串起来：ITCM/外部备份、加密 payload、断电运行后 RAM 内部备份、RDP 解锁和原厂恢复。因此原始 backup 不必作为新工具链必需组件。工作区新增 gnw_full_backup.py 则是另一种高层能力：改装机双256KiB Bank、探测整颗外部Flash、两遍读取、辅助寄存器归档、manifest校验、按区恢复/回读和远程拉取。当前 gnwmanager 尚无等价完整打包命令，可将这些高层能力整合进去，再让 backup 退为兼容工具。

传统 Retro-Go 的 OpenOCD 路径主要是旧刷写/flashapp通信、擦除、启动/复位、存档区域读写、调试。对应用户功能仍有价值，多数已有 *_gnwmanager 目标；保留旧驱动本身不是必须。flash_test 专门验证固件内旧flashapp/Flash驱动，若需要验证这段代码就保留低层流程；若只为制作运行profile不必优先做。RESET_DBGMCU 等尾部调用与旧savestate脚本需要迁移，不能仅切换flash目标就宣布彻底摆脱OpenOCD。

UI启动时只创建SessionController；没有profile参数或显式加载时不启动QEMU。load先校验新profile和QEMU路径，再stop旧进程，然后新spawn；因此换ROM（同profile重载也一样）会换QEMU进程，持久化介质沿用session，CPU/RAM重新启动。无效新profile在stop之前报错保留旧运行。daemon改造应让socket服务持续存在，QEMU实例仍可随加载/切换重建。

### 2026-11-12 上游核对与最小架构

直接读取 sylverb/game-and-watch-retro-go 的 filesystem_wip/Makefile.common 和README，以及 sylverb/game-and-watch-retro-go-sd main分支的Makefile与docs/gwemu.md：推荐Flash版的flash、erase、format、pull/push、monitor都使用gnwmanager。Flash-only一词要区分旧内嵌ROM版、filesystem_wip版和新版retro-go-sd SD_CARD=0 FrogFS版；不可混用。

第一阶段可保持UI拥有QEMU：加载时启动，关闭时停止；增加当前目标的连接发现/管理lease；外部gnwmanager断开不停止目标，换ROM或退出UI不得无提示打断正在刷写的管理流程。虚拟设备关机/冷断电的宿主控制连接应保持，必要时UI协调QEMU重启并让工具重连。当前QEMU参数没有gdb入口，要按所选backend新增。无需为了跨命令访问引入savestate或独立daemon。

OCDBackend是gnwmanager的抽象接口，不是OpenOCD通信协议；实现其内存、寄存器、暂停/运行/复位、调试器服务能力即可支持上层。可新增EmuBackend直接走本地RPC，也可补现有GDBBackend。GDB remote协议和QEMU gdbstub本身并非未完成；未完成的是本地backend的部分能力。若需要gnwmanager gdb/gdbserver完整功能，仍需对外提供GDB RSP或转接QEMU已有stub，不能通过更换接口名称消除调试需求。完整功能仍取决于QEMU外设/RDP/电源行为，不能仅靠传输等价保证。

公开模拟器证据（未进行其运行验证）：

- https://github.com/slash-proc/gwemu ：描述为模拟GnW/STM32H7B0的QEMU fork，默认gnw-h7b0分支。API显示最新预发布v0.0.29于2026-10-22发布。
- https://github.com/sylverb/game-and-watch-retro-go-sd/blob/main/docs/gwemu.md ：已有固件生成镜像、交互GDB、日志/异常捕获、确定输入、无界面捕获流程；同一文档要求对实机复现差异。
- https://github.com/autinerd/game_and_watch_emulator ：早期实验README称Retro-Go菜单部分工作、游戏和原厂固件尚不可用；不应视为成熟替代品。

研究工具记录：Exa未配置，改用GitHub CLI及上游raw文件；若干README路径404，通过仓库API定位。外部原文保存在/tmp，不执行其中命令。

## 当前基础与各项目工作

| 项目 | 已有基础 | 推荐新增能力 | 优先级 |
|---|---|---|---|
| game-and-watch-backup | 初次备份/解锁脚本；gnw_full_backup.py 保存 Bank1、Bank2、ext 和校验 manifest | 已有备份目录导入/导出 profile；会话 Flash/SD 归档；实机备份结束可选输出 profile | 导入 P0，会话归档 P1 |
| game-and-watch-patch | make/patch.py 已离线产出 internal/external patched BIN | --profile 输入解析、--output-profile 输出；明确接受原厂基线；保持加解密配对；组合 bootloader/Bank2 | P0 |
| game-and-watch-retro-go | make all 已产出内部、外部及 .flash2 分段；刷机目标分离 | make emu-profile；把 ELF/构建布局转为整颗 Flash 镜像；单系统/双系统预设 | P0 |
| gnwmanager | 已有 GDBBackend；flash 运行 RAM 固件；flash-patch 先离线生成再连接 | 先抽出 patch/build-profile 离线导出，再增加 profile 目标的离线镜像操作和运行中 QEMU 连接 | 离线 P0，runtime P1 |
| retro-go-sd | gnw-emu 已有构建、卡镜像、双系统组装脚本；项目已有另一个模拟器的 gwemu_release | 原生 gnw-emu profile 导出；明确 bootloader、bank、外部容量、接线；SD 内容打包与一致性检查 | P0 |

具体证据：

- desktop/src/core/schemas.ts、profile-store.ts、session-store.ts：严格 profile v1 与会话首次复制逻辑。
- desktop/tools/cli.ts：已有 create、ensure、paths、session-dir、probe、launch。
- scripts/run_backup.sh：已有备份到 profile 的入口，但目前 model 固定 zelda。
- scripts/make_sd_dualboot.py：0x32000 bootloader 拼装，Bank1 256 KiB、外部容量均用 0xff 补齐。
- game-and-watch-retro-go/Makefile.common：flash_extflash_gnwmanager 使用 EXTFLASH_OFFSET；内部目标使用 INTFLASH_ADDRESS。
- gnwmanager/gnwmanager/cli/_patch.py：补丁成功后才打开目标连接，可抽出纯导出步骤。
- gnwmanager/gnwmanager/ocdbackend/gdb_backend.py：已经实现与 QEMU gdbstub 通讯，不需要从零编写调试协议。
- retro-go-sd/Makefile.common 的 gwemu_release：面向 slash-proc/gwemu，固定 64 MiB、零填充，并在已有文件时跳过生成；这不是 gnw-emu profile 支持。

顶层项目与 gnw-emu/externals 下的项目副本不能默认同版本。实施前应固定实际 fork、commit、补丁接口及产物名称。

## 公共架构

建议抽出小型 profile/image 公共工具包，提供机器可读 schema、Python API 和 CLI，避免五处分别重写相对路径、UUID、校验、镜像组装。第一阶段也可调用现有 Node CLI 验证契约；长期不宜要求每个 Python 工具安装完整 Electron 才能导出 JSON。

职责分为：

- Profile：载入、校验、相对路径、保存及身份规则。
- Image builder：根据分段起始地址和容量组装 Bank1、Bank2、外部 Flash、SD。
- Offline operations：复制基线后执行写入范围、擦除或文件系统修改，原子发布新包。
- Runtime adapter：启动/连接 QEMU，使用 GDB 或 QMP 操作，管理会话锁和退出。

推荐包结构：

```text
my-build/
  game.gnw.json
  bank1.bin
  bank2.bin
  flash.bin
  sdcard.img
  build-manifest.json
```

现有 profile v1 足够表示启动所需资源。构建参数、Git commit、分段布局、来源 SHA-256、core ABI 放入旁路 manifest；v1 拒绝未知字段，不能直接加这些键。只有启动需求确实增加时才设计 profile v2。

## 必须先解决的细节

### 镜像布局

- profile 指向整机的存储镜像，外部固件分区需要写到 EXTFLASH_OFFSET，而不是简单重命名。
- Bank1 地址 0x08000000，Bank2 地址 0x08100000，两者不是在文件内直接连续拼接的两个 256 KiB 块。
- intflash2.bin 来自 .flash2，必须结合 ELF/链接配置判断所属 Bank 和地址。传统 Retro-Go Bank2 构建与 SD 版布局不得混用假设。
- 擦除态填充一般应为 0xff；现有 gwemu 的零填充流程不能直接复制。
- 双系统时保存原厂/补丁区域，计算 bootloader、Retro-Go、ROM、存档分区重叠；覆盖必须明确。
- 无原厂基线的单系统要提供真正可启动的 Bank1 固件/独立 bootloader。空白 Bank1 加 Bank2 并不自动意味着上电会进入 Bank2。
- profile 现有尺寸校验只是入口边界，并不是硬件容量或分区正确性的证明。额外校验容量、链接地址、向量表及接线/固件匹配。

### 身份、更新与会话

- id 是宿主存档 UUID；deviceUid 是 STM32 96 位身份。两者不能混用。
- SD Flash 缓存元数据包含 UID。导入备份时尽量保留真实 UID；虚拟设备需要稳定 UID，并明确更换时的缓存失效行为及字节序。
- 顶层完整备份 manifest 目前没有记录 model 和 UID，需补齐或要求显式输入，不能只靠文件名推断。
- prepareSession 对首次运行复制镜像，已存在会话不会被覆盖。因此同路径替换 BIN 后复用 UUID，会继续运行旧会话镜像。
- 建议独立新构建默认新 UUID；日常启动复用 UUID；向当前会话升级固件保留身份；会话导出到新 profile 使用新 UUID，但保留设备 UID 和持久化介质。
- 源镜像与会话介质操作必须明确；离线文件修改仅在对应会话关闭时执行，并使用同一锁。暂停 CPU 不足以允许宿主和 QEMU 同时改写挂载的 SD/Flash 文件。

### gnwmanager 的两条路线

离线镜像后端适合包制作、分区读写和备份恢复；不应伪装成完整 OCDBackend。现有 GnW API 依赖 RAM 管理固件、mailbox 和目标执行，单纯提供文件 read_memory/write_memory 并不能使这些命令全部可用。需在高层分离离线操作与目标操作。

GDB runtime 路线复用现有后端，实际运行 RAM 管理固件。应先验证 info、dump、flash bank1/bank2/ext、start，再逐项开放 LittleFS 与 SD 命令。小文件与大文件、压缩传输、HASH、超时、复位后重连和擦除写回均需验证。

桌面 qemuArguments 当前没有 GDB endpoint 配置。需要 gnw-emu 提供开发连接入口、动态端口/发现信息、会话级互斥及管理结束后的恢复行为；连接/启动选项不属于可移植 ROM profile 字段。

lock/unlock、探针相关命令不能因为选择了 profile 就宣称已模拟成功。当前 gnw_flash reset 将 RDP 设置为 level 0，不能据此验证真实首次解锁保护机制。

### 文件系统与 SD

- LittleFS、FrogFS、FAT32/exFAT 需要不同操作，不能把 gnwmanager 的 LittleFS 命令等同于 SD 内容管理。
- SD 2.x 核心、ABI、BIOS、字体、语言包与 ROM 目录需统一打包/校验。
- FAT32 镜像可复用 make_sd_image.py；exFAT 工具及跨平台行为另行验证。
- SD 内容与 Flash 缓存、UID 有关联，导出当前会话时应一致归档全部持久化介质。
- 大卡镜像完全复制成本高，第一阶段限定合理尺寸，后续再考虑 reflink/块 overlay。无需把完整快照优化作为离线导出的前置条件。

## 分期与粗估

以一名熟悉本工作区的工程师、复用现有脚本、聚焦本地 fork 为前提：

| 阶段 | 交付 | 粗估 |
|---|---|---|
| A | 固定契约、公共校验/布局库、通用备份导入、会话身份规则 | 3–5 人日 |
| B | patch、传统 Retro-Go、SD Retro-Go 导出，gnwmanager 离线补丁导出和启动验证 | 5–10 人日 |
| C | gnwmanager profile/runtime 接入、GDB 生命周期、关键刷写/导出流程 | 5–10 人日 |
| D | 文件系统/SD 管理完善、三平台工具链/路径验证、回归与文档 | 5–10 人日 |

A+B 的实用版本约 2–3 周；较完整工具链约 4–7 周。模拟器缺失外设/管理固件不兼容、exFAT、所有历史固件覆盖、上游接受和真实保护流程仿真会增加工期。该估算不是实施承诺，应以首次纵向验证校准。

首个纵向切片推荐：备份/构建输入 → 同一公共镜像组装器 → 相对路径 profile → 独立启动 → 固件内存档 → 重启保持 → 关闭会话后归档。随后完成无原厂备份的 SD bootloader + Retro-Go 路径，证明自制固件工作流确实不依赖实机。

## 验收

1. 比对每个 Flash 写入区间，确认导出内容与实机刷写目标相同，剩余区填充正确且无重叠。
2. Mario/Zelda、Bank1 单系统、Bank2 双系统、SD SPI1/OSPI，各有启动与交互覆盖。
3. 补丁原厂及 Retro-Go 的存档经过重启仍存在；SD 卡升级后 Bank2 与预期固件逐字节一致。
4. 新构建/复用/原地升级/会话导出符合 UUID 规则，不修改基线或误用旧会话。
5. 模拟器运行时禁止离线并发修改；操作中断保留原有可运行包。
6. 全部离线命令不依赖 USB 探针和 OpenOCD；测试素材用自制 ROM，或由本地私有固件 fixture 提供。

模拟器测试能证明软件流程，不能替代真实 SD 时序、电气、供电与 RDP 安全行为测试。现有 docs/sdcard.md 明确 SD 模型理想化且仅验证 FAT32。本次未运行这些验收项。
