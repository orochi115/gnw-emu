# gnwmanager 最小接入范围与 gwemu 对比

日期：2026-11-12。只做源码、文档、发布元数据调查；没有构建或运行 gwemu，没有验证两套模拟器对同一固件的实际兼容性。本文补充前一天的工具链评估。

**讨论后的决定：** 最终以 gwemu 替换旧 QEMU 内核，双内核仅用于迁移期对照；完整备份迁入 gnwmanager，各自验收后退出并归档旧 QEMU/backup fork，再完成当前会话接入与全功能验收。本文末尾“可选内核”保留为决策前的候选建议，最终路线见 [迁移设计](../superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md)。

## 1. 三项工作是否足够

用户提出：移植 gnw_full_backup.py、补齐 GDBBackend、重新编译 QEMU 开启 GDB。

方向可以收敛到 gnwmanager 和模拟器，不必为当前 sylverb 工具链实现 OpenOCD 兼容服务。但这三项不能直接等同于全功能覆盖。

- 本地 build/qemu-system-arm --help 已列出 -gdb、-s、-S。第三项应改成运行时开放调试入口。desktop/src/core/qemu-command.ts 当前没有传入 -gdb。
- UI 仍可持有 QEMU，gnwmanager 连接当前会话；不要求 daemon。需要发布当前端点、会话身份和状态；换 ROM、关闭 UI 时应让客户端明确断开。GDB 负责 CPU/寄存器/内存，QMP 或 UI 控制接口负责机器电源、输入等。一个统一的会话发现入口可以返回多个协议端点，无须把所有操作塞进 GDB。
- GDBBackend 需要核对目标寄存器描述、halt/resume/reset 时序、分包与错误处理。当前寄存器表把 msp 当 r13，连接后直接 resume，reset_and_halt 先运行再暂停；start_gdbserver 明确未实现。外部 gdb 需要连接交接，因为 QEMU stub 只有一个客户端。
- gnwmanager 不是只改镜像：它会上传 SRAM 管理固件并运行，通过固件操作 Flash、SD 和文件系统。GDB 连接成功不等于这些固件依赖的外设都能工作。
- 本地 gnw_flash.c reset 将 RDP 固定为 level 0（0x0000aaf0）；完整 unlock/lock 需要保护状态、选项字节转换及相应擦除/访问限制。UI USB 电源、电量调节还不能替代真实电池断开和冷启动语义。savestate 是回滚工具，也不能自动产生这些硬件行为。
- 最终需要按实际 CLI 验收备份/校验/还原、刷写/擦除、文件管理、截图/监视、debugger 接管、解锁/重新保护、电源操作。当前仅源码审查不能给出全通过结论。

若目标仅是已经解锁镜像上的刷写、备份和文件管理，可以先排除首次解锁流程，形成更小的可用版本；如果用户要求全功能，就必须保留后两项模型与验证工作。

## 2. backup 和旧 Retro-Go 的退出范围

gnwmanager 的 unlock 已覆盖旧 backup 的核心备份/注入/解锁/还原流程，但尚不能因此宣称已覆盖本地增强脚本 gnw_full_backup.py 的全部功能。该脚本还包含：双 bank 完整备份、外部 Flash 全容量、双读比对、ITCM/选项字节/RTC 归档、哈希 manifest、独立校验、分区恢复和读回、远程拉取校验。原始 RAM/ITCM 捕获不能先 reset 或启动管理固件，否则现场已改变；需要低层无复位读取路径。

这些能力迁入并验收后，backup 可以退出用户的常用工具链，保留历史归档格式与恢复能力。不需要继续让 backup 作为运行依赖，也没有理由删除历史备份。

当前 sylverb Flash-only 推荐分支 filesystem_wip 与 SD main 已使用 gnwmanager；Flash-only 的 RESET_DBGMCU_CMD 也变为 -- disable-debug。旧分支中的 OpenOCD 刷机路径可以退出这套选定工具链，不构成必须实现兼容层的理由。但 sylverb 是 Retro-Go 的分支/维护版本，不宜表述成整个 Retro-Go 被另一个项目全面淘汰；Flash-only 和 SD 版本仍各有用途。

上游依据：

- https://github.com/sylverb/game-and-watch-retro-go/blob/filesystem_wip/Makefile.common
- https://github.com/sylverb/game-and-watch-retro-go-sd/blob/main/Makefile.common

## 3. gwemu 的实际定位

调查对象是 slash-proc/gwemu，默认分支 gnw-h7b0，核对的分支提交为 3bfce5fd（2026-10-21）。发布列表首项 v0.0.29（2026-10-22）仍标为 prerelease，提供 Windows/macOS/Linux 包。不能只从版本号断言不稳定，也不能称其已成熟到完全替代硬件。

它已经实际接入 sylverb 的 SD Retro-Go 开发流程，官方集成文档明确支持 SD 和 SD_CARD=0 的 Flash 文件系统固件、GDB 日志/异常诊断、无界面输入回放和视频采集、Docker/CI；强调模拟器与硬件使用同一固件字节，最终仍需实机验证。

- 项目：https://github.com/slash-proc/gwemu
- 发布：https://github.com/slash-proc/gwemu/releases/tag/v0.0.29
- 已采用的开发工作流：https://github.com/sylverb/game-and-watch-retro-go-sd/blob/main/docs/gwemu.md

## 4. 重叠与区别

| 范围 | gwemu 调查结果 | gnw-emu 现状与价值 |
| --- | --- | --- |
| OFW/Homebrew/Retro-Go | 文档与集成描述支持 Mario/Zelda、Retro-Go、SD、音频 | 同类目标，不能当独有功能 |
| 桌面产品 | SDL3/ImGui UI，跨平台包，输入与游戏手柄 | Electron 桌面、机身交互、中英界面、时钟停靠等已有投入；优劣应由使用体验判断 |
| profiles | profile.toml，profile 自有 Flash、SD 配置、RDP 状态 | .gnw.json 基线与 UUID 会话隔离；两者是不同契约，需要映射，不能声称只有 gnw-emu 有 profile |
| 开发/自动化 | GDB、headless、确定性输入、捕获及上游脚本 | 可保留现有 UI/回归测试与实机测量数据，互相验证模型 |
| MCU 外设/时钟 | RCC 动态时钟、较广外设模型、实验性指令/缓存/总线时序 | 本地 cycle-accuracy.md 记录固定时钟等差距；继续独立补齐会有明显重复成本 |
| 解锁/保护 | FLASH_R 有 RDP 持久化、访问门控、RDP1→0 擦除；有冷启动及特定 unlock payload 兼容逻辑 | 本地 RDP 固定为 0；全工具链覆盖有模型缺口 |
| 电源交互 | 所查 GPIO 源码明确 PGOOD 固定有效，称无 battery/charger UI | 已有电量、USB 电源操作；仍需补电池存在与冷启动 |
| SD 接线 | 确认专用 SPI1 支持；未确认 GPIO/OSPI 软件 SPI 接线兼容性 | 本地已有软件 SPI 接线能力与测试，迁移前需逐项验证 |
| 即时存档 | 源码中存在相关 UI/历史文件，未验证当前完整工作流 | 当前文档明确回滚 CPU/RAM/外设与全部 Flash；不支持挂载 SD，外部 Flash 上限 64 MiB |

RDP 支持不等于电气/安全机制完全忠实。gwemu 的冷启动/解锁有已知 payload 专用兼容处理；两者都不能因有 QEMU/GDB 就当成真实 STM32 的完全替代品。实验性时序模型也不等于周期精确。

docs/STATUS.md 最后更新时间早于最新发布数月，其中历史故障不能直接当作当前故障。另发现 ui/gwemu-snapshots.c 内容异常，但当前 ui/meson.build 的直接源码列表不包含它；未追踪完整链接路径、未构建，不能据此断言发布包损坏，也不能仅凭该文件名确认当前存档功能。替换内核前应进行可重复构建和运行验证。

## 5. 对 gnw-emu 的建议

如果唯一目标是运行和调试当前 Retro-Go/Homebrew，优先使用 gwemu 的现成开发集成，继续从头维护同类 STM32 模型的收益有限。

如果目标包含桌面时钟/机身体验、可移植 profile、安全的会话隔离，以及模拟备份刷机与电源操作，gnw-emu 仍有产品与工作流价值。不过这些价值并不要求它永久维护完全独立的 MCU 内核。

建议先用同一组内部/外部 Flash 与 SD 镜像对比 OFW、Flash-only Retro-Go、SD Retro-Go、gnwmanager RAM 固件；核对持久化、保护、冷启动、音频、输入和存档。结果合适时，考虑把 gwemu 作为可选内核，或者移植/共同维护缺失模型。现有 UI 依赖定制 QMP/QOM、帧流和 CLI 机器参数，不能直接替换可执行文件；需要协议/参数与 profile 映射。也不必将两套 UI 合并。

采用 gwemu 并不自动补齐 gnwmanager backend 或完整备份，也不自动实现用户要求的所有 .gnw.json 会话语义。最终验收清单与选择哪套内核无关。
