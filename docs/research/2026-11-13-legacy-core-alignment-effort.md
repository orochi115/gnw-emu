# legacy core 对齐 gwemu 的工作量评估

## 结论与估算口径

这是基于本机冻结源码和既有验收记录的工程估算，尚未对 legacy 执行一次完整的新验收矩阵，因此不是实测工时或承诺。按一位熟悉 QEMU/STM32 的工程师、5 天/人周、可以复用现有 gwemu 代码和测试估计。原 ROM、真实 UserData、旧 checkout/build 均未改动；不包括真机验证、跨平台发布、旧用户数据/旧存档格式兼容，也没有实施反向移植。

| 目标 | 累计工作量 | 验收含义 |
| --- | --- | --- |
| 常用固件的有限实用补齐 | 8–15 人日，约 1.5–3 人周 | Mario/Zelda OFW、Flash/SD Retro-Go 常用启动、RTC、画面、音频、存储；修补实测差异。不等于完整新产品功能 |
| 当前桌面产品合同对齐 | 31–55 人日，约 6–11 人周 | 上一行，加 USB/电池拔插与断供恢复、RDP/选项字节、冷启动、可靠存档事务、现有 manager 全流程、构建与测试恢复 |
| 产品加主要外设功能对齐 | 70–125 人日，约 14–25 人周（3–6 个月） | 上一行，加动态时钟传播、DMA/MDMA、HASH/CCM/JPEG、显示和音频的相应接口/恢复语义 |
| 连实验性 CPU/cache/总线周期模型也搬入 | 在上一行之外增加约 40–80 人日 | 涉及 TCG/CPU 执行路径、profile、外设定时和校准；低置信度。移植成功不代表真实硬件周期准确 |

以上是不同范围的累计估计，不能把各行相加。前两档置信度中等；外设档中低；周期模型档低。开始时应先用 2–3 人日恢复独立构建/适配测试，得到实际失败清单后收窄估计，此工作已包含在表内。若目标只是作为冻结对照运行，现有历史 build 已足够，不需要这些投入。

## 已有能力和实质差距

legacy 并非空壳：`gnw_timer.c` 已使用 `qemu_get_timedate` 模拟宿主硬件 RTC；`gnw_spi.c` 已有 FIFO/DMA；`gnw_dma.c` 已有 DMA1/2、DMAMUX1、音频与部分内存搬运；`gnw_ltdc.c` 已有八格式解码、DMA2D/YCbCr；`gnw_adc.c` 和 `gnw.c` 已有电池/USB、充放电；多个设备已有 VMState。它还有 Stop/Standby hook，仍可作为研究参照。因此不能把 RTC、SPI、音频、DMA2D 或存档全部按从零开发计价。

| 部分 | 源码证据与差距 | 工程影响 |
| --- | --- | --- |
| QEMU 基础 | legacy `externals/qemu/VERSION` 为 11.1.3；gwemu `VERSION.txt` 为 11.0.2 | 两者都是现代 QEMU；“更新的 QEMU”不是 gwemu 在本项目的优势，不计整版升级成本 |
| RCC/时钟 | legacy `gnw_regs.c` RCC 主要回显 ready/SWS；`gnw.c` 固定 SYSCLK。gwemu RCC 有 PLL/分频、时钟对象与 engine observer | 要修改 CPU、TIM、SAI、LTDC、DMA 等连接和恢复状态；无法仅复制几个寄存器函数 |
| DMA/MDMA | legacy DMAMUX2/BDMA/MDMA 为寄存器 stub；gwemu 有实际 MDMA SW-request 搬运与可选定时路径 | MDMA 功能是真差距，但不能声称 gwemu 所有 DMA 模式已实现；其 MDMA 注释明确限制等宽、非 linked-list 等范围 |
| HASH/CRYP | legacy HASH 的 SHA224 明确未支持，缺少 HMAC 状态机；CRYP 有 ECB/CBC/CTR/GCM。gwemu 有 SHA224/HMAC、CCM、DMA 协作 | 算法代码可复用，寄存器流程、IRQ/DMA、字节序和 VMState 仍需适配；GCM 已有实现也要验证新修复 |
| JPEG | legacy `gnw_jpeg.c` 明确 decode-only；gwemu 有 baseline 4:4:4 编码和解码 | 不应按全新 JPEG 库估算；主要是设备接口、分块、worker/状态协调 |
| Flash/保护 | legacy `gnw_flash.c` 默认 RDP0，普通寄存器写；没有当前 gwemu 的完整保护转换/sidecar 合同。NOR 已有 WEL | 内部 Flash 写擦除与 RDP 降级、重新保护、复位、持久化需专项补齐；不能用“能刷写”替代 unlock 验收 |
| 电源 | legacy 有电量和 USB 充放电，但无当前显式 battery-present 与有效供电丢失/恢复产品合同 | 复用 ADC/PGOOD，增加机器供电状态、拔电池、冷启动、RTC/持久化协调；保留并验证已有 Stop/Standby 行为 |
| 存档 | legacy `gnw_state_file()` 已保存 CPU/RAM/Flash 并恢复 LTDC，限制 SD/64MiB；写入直接 O_TRUNC，加载在检查 header 后重置 VM | 新数据不要求兼容旧格式，可重新定义；仍要补 checksum/preflight、失败回滚、Flash/保护 sidecar 事务、音频与外设恢复一致性 |
| 桌面和 manager | 当前 `KernelKind` 只接受 gwemu，preflight/参数/能力检查/电源快照均按新合同。旧有 frame transport、session lock、GDB 基础可复用 | 恢复 adapter 和测试入口；共享 UI/RPC/CLI/备份验证可以复用，无须重写 gnwmanager 备份产品 |
| CPU/cache/总线定时 | gwemu `include/exec/gnw-cycle-model.h` 和 `accel/tcg/gnw-cycle-model.c` 有 experimental producer、cache、XIP/bus/profile | 属可选研究范围，不纳入桌面可用性对齐。没有宣称它是硬件级准确或产品默认必须依赖 |

本轮查到的 stub 名称不代表它们都必须实现：例如 BDMA/DMAMUX2 必须先确认 gwemu 对应能力及目标固件需求，再列入工作；不会因为 legacy 是 stub 就无限扩充目标。

## 当前产品档的分解

| 工作包 | 人日 | 内容 |
| --- | --- | --- |
| 恢复构建、adapter 与常用固件差异 | 6–11 | 重接维护索引、测试夹具和机器参数；复验 RTC、画面、音频、SD、OSPI/CRYP 修复适用性 |
| 电池存在、供电与冷启动 | 4–7 | 对齐显式状态/能力、断供/恢复和充电合同，验证已有睡眠 hook |
| Flash、RDP/选项字节与持久化 | 4–8 | 降级/保护/重置/文件落盘合同与故障路径 |
| 存档可靠性 | 6–10 | 文件事务、预验证/校验、失败回滚、外部副作用恢复；保留既有 SD/容量边界 |
| manager 接入与协调 | 4–7 | RAM 管理固件、GDB/QMP 协作、刷写/文件系统/截图/备份/解锁验收；复用现有上层产品 |
| 构建、产物身份与发布入口 | 2–4 | 恢复构建依赖、manifest、kernel identity 与包资源选择 |
| 综合验收及实证回归修复 | 5–8 | 原文件哈希、会话释放、拒绝损坏状态、两款 OFW 与 Flash/SD 工作流；不重复前项局部测试 |
| 合计 | 31–55 | 已包括 2–3 天前期缩小不确定性的验证 |

达到主要外设档，额外约 39–70 人日：RCC/时钟传播 10–18、DMA/MDMA 8–14、HASH/CCM/JPEG 6–12、显示/音频及状态协调 8–14、跨设备回归 7–12。可借用 gwemu 算法实现缩短代码编写，但 QOM/结构体/设备连接不同，复制文件不能完成移植。

## 维护判断

若用户明确需要 legacy 独有行为或可重复的 gwemu 性能/准确性退步，有限补齐可以合理；应先用同一固件和工作流证明差异。当前没有证据说明恢复双产品内核会带来与上述投入相称的收益，建议继续维护 gwemu，冻结 legacy 用作对照。当前用户观察到的尺寸错误来自共享桌面布局，并不能证明新设备模型整体差于旧模型。

持续维护的成本来自两套设备状态、参数与能力合同的验证；共享 UI/manager 仍只维护一套。后续每次涉及 native 状态、供电、时钟、存储的修改都需要双内核验证，不能把一次补齐工时理解为后续免费维护，也没有依据给出固定百分比成本。

## 本轮 LCD 尺寸问题

gwemu 输出 640×480（320×240 LCD 的 2 倍 surface）。窗口几何按 LCD 320×240 计算，renderer 却按 frame.width/height 计算物理尺寸，导致 2× 预设实际为 1280×960，而窗口预期 640×480。保留 transport/backing canvas 640×480，布局统一使用共享 LCD_WIDTH/LCD_HEIGHT；包括皮肤 aperture、居中、遮罩、plain 和 fit 路径。不是 native LTDC 像素内容错误。

既有 Zelda/Mario 像素预设测试在修复前均报 640×480 预期、1280×960 实际；更新棋盘夹具让一个 LCD 像素对应 2×2 transport 像素，并显式要求收到 640×480 canvas，物理尺寸断言不放宽。旧缩放菜单断言改为只筛选 view.scale.*，避免新增存档槽 radio 被计入。开发桌面必须重新 build，因为 launcher 只在输出缺失时自动构建；本轮已重建供 run_stock_emu.sh 使用的产物，未重打包旧 macOS app。

验证结果见下面的最终记录；本地日志 `out/gwemu-lcd-sizing-*.log`，截图 `out/ui-validation/`。真实 UserData 无修改；测试使用临时 UserData 和会话副本。

### 最终验证记录

- 开发桌面 `npm run build` 和 `npm run typecheck` 成功；clock geometry / window mode 两文件共 15 项单元测试通过。
- 两款真实固件的独立 physical LCD 回归 2 项通过：明确要求 backing canvas 640×480、默认 4× 物理 LCD 1280×960；带边框和 plain 的 0.5/1/2/3× 显示尺寸、aperture 对齐、全 LCD 棋盘像素截图与会话 ID 保持全部通过。日志 `out/gwemu-lcd-sizing-physical-final.log`。
- 既有 live chassis/input/toggle 和 preference persistence 两项通过；既有 desktop clock/session/fit/bounds 一项在重跑中通过。尺寸计算的直接回归已通过，不将不同运行的结果表述为全套一次通过。
- 完整旧 pixel-presets/restart 测试：Zelda 显示、第一轮退出/重开及恢复尺寸检查通过到第二次退出，随后应用退出超时；等待 native running 并延长等待的诊断仍复现。Mario 在该轮有 Electron firstWindow 启动超时。原退出测试逻辑已恢复，不以更换退出入口或忽略退出码让其变绿。这两项不计通过，保留本地 trace/log，属于本轮记录的独立限制；没有因此修改产品退出生命周期。
- 核对工作区 wrapper：优先目录 gnw-emu-electron-ui 已不存在，默认实际使用本轮 gnw-emu；显式 GNW_EMU_DIR 仍由用户环境决定。已有 macOS app 包未更新。
- 生产修改只涉及 renderer 的 LCD 布局和共用尺寸常量；native、manager、真实 UserData、历史 legacy 与原 ROM 不改动。
