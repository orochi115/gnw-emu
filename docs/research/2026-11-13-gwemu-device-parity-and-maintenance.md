# 设备差异修复与 legacy 维护判断

基于上轮原厂设置/设备审查，补齐已复现的局部功能缺口。native 源码为 `57b2b378e2001f20a241ecbaf9ce7c8f22aae9a3`；父仓库仅本地提交，native 发布至已授权的公开 fork。真机、原 ROM、实际 UserData 和历史 legacy checkout/build 不改动。

## 修复

| 部分 | 现在的行为 | 针对性证据 |
| --- | --- | --- |
| NOR 功能模式 | 编程/擦除需要 WEL；编程只能 1→0；256 字节页内回绕；读 array 不消耗 WEL，完整 program 后消耗 | 5 个失败用例转为通过；程序退出后文件字节验证。原先无需 WREN 的存档夹具改为真实 WREN 序列 |
| NOR 既有 timed 4PP4B 路径 | 同样检查 WEL、按位 AND 和页内回绕 | 两个 timed 用例修前失败、修后通过；没有宣称扩展所有芯片/opcode 的时序模型 |
| DAC | 单/双通道 DHR 视图共享数据；EN 门控；无触发自动转移；TSEL=0 的软件触发选通 DOR；SWTRGR 自清零；DOR 只读 | 5 个失败用例转为通过，含禁用后保持与重新使能。外部触发/模拟波形/真实 APB 延迟没有新增实现 |
| 背光 | LTDC scanout 从 PA4 digital ODR 或 DAC1 DOR1 取亮度；暗屏、半亮和全亮可作用于暂停画面 | synthetic MMIO/screendump 失败转通过；实际 Mario 副本平均灰度约 123→0，与 legacy 相同。worker 不读 live GPIO/DAC，亮度在 BQL 下发布 surface 时取值 |
| LTDC | 两层都覆盖八种合法 PFCR 格式；新增 Layer 1 通用解码，保留 RGB565/L8 快路径；字节宽度、snapshot 和 dirty range 同步处理 | Layer 1 八格式像素矩阵通过，含透明 AL44/AL88；既有 Layer 2、存档像素/CLUT/重新 capture 回归通过 |
| PWR | WKUPCR W1C 清 WKUPFR 并自清零；WKUPFR 只读；CSSF 清 STOPF/SBF 并自清零；普通控制写保留硬件状态；byte lane 正确 | 三个失败用例转通过。普通 POWER/Standby 模型启动有 WKUPF1。未照搬 legacy 先屏蔽 CSSF 再测试、导致无法清 SBF 的错误 |
| TIM | TIM2/5 的 CNT/ARR 为 32 位，TIM3/4/6/7/12/13/14 为 16 位 | 九实例写入/读回矩阵；四个旧失败实例修后通过，既有动态 RCC/IRQ/OPM 路径保留 |

## 冷启动根因与验收纠正

上轮两个 Retro-Go 冷启动失败不是 POWER 边沿未送达：实测 IRQ 可唤醒 CPU。原测试依赖 OSPI/CRYP 设置校验失败后出现 PRESS TIME，再由 TIME 重置 12:00 的分支。设置读取修好后，固件可以直接恢复设置并进入 Stop，TIME 不属于此时的唤醒源。将 LEFT+GAME 放在 POWER 唤醒期间，Flash/SD 均正常到达 `VTOR=0x08100000`，host RTC 的 09:00 保持，未强制跳转、未屏蔽固件设时、未改 TAMP 魔数。

原厂固件断电后用 TIME 配合短按 POWER 进入时钟：一秒 POWER 长按会让 Zelda 再次关机。午夜 Zelda 时钟本身大部分黑色，只有约 5,900 个亮像素，不能沿用 launcher 的 20,000 阈值。原厂画面检查采用 1,000 阈值，但仍要求复位前后 LTDC 从关闭到重新启用；Retro-Go 保留 20,000 与 Bank 2 校验。之前保持旧 surface 但 GCR 关闭的失败仍被拒绝，没有把它计为新帧。

这关闭了已复现冷启动问题的调查，不代表完整 MCU Stop/Standby 时序已实现。旧内核的 Standby POWER→复位、Stop/SysTick 门控仍有可研究的源码；当前失败没有证据需要移入这些 hook，因此按用户有限审查要求，不引入猜测性的协调逻辑。

## 验证与产物

干净源码在独立 `build/gwemu-device-parity` 构建，manifest 的 `sourceDirty=false`、源码 revision、实际 binary SHA-256 均核对。binary SHA-256：`f41b093d72a03f0354e8e3c88b827e59a398eeccf0b9765f48f18a8cfa4ebdbd`。`build/gwemu` 指向此产物，开发启动脚本使用它；本轮未重新打包已有 macOS app。

- 干净产物 240 项直接 native 回归通过，含本轮 33 项 device parity，以及 stock OSPI/CRYP、RTC、USB/电池供电、manager SPI、存档与桌面传输。
- 固件和 SD 均挂载副本；每个成功/失败用例 finally 均复核原文件 SHA-256；实际 Mario session 的 bank1/flash 对照探针也复核哈希不变。
- 真实 Electron 预览、软件 SPI SD、供电丢失/恢复 3 项通过。
- 干净产物完整 copied firmware 验收 14 项通过：6 项 RTC/TIME/重开，8 项 Mario/Zelda/Flash/SD 的两次冷启动与冗余电源/断供恢复。原问题没有遗留失败。
- 实际 Electron/public manager 存储 1 项通过，14 条 CLI 命令验证备份/恢复、NOR flash/dump、文件系统与截图，并核对 native/client/endpoint 全部释放。最初一次应用启动挂起、清理超时，退出后重跑通过；临时错误打印已移除，未为此改生产代码。测试的固定 native revision 更新到本轮干净源码，仍校验 artifact hash。

本地证据位于 `out/gwemu-device-fixes/`，另有既有 firmware/e2e 输出目录；ROM、截图与 trace 不发布。

## 是否继续维护旧内核

建议：**保留 legacy 为冻结的源码和运行对照，不恢复双内核产品维护。** 已确认的 NOR/DAC/背光/PWR/TIM/Layer 1 优势都是局部语义，现已补到新内核。legacy 并不始终更准（CSSF 就是反例），单凭更短的代码或设备 stub 注释不能判断整体成熟度。

gwemu 已具有现代 QEMU 基础、动态 RCC/DMA/MDMA、编解码、存档/会话保护、manager 工作流与桌面供电集成。维持两个产品内核会再次重复维护启动参数、输入、电源、状态格式、测试、打包和安全边界；目前没有实证独有功能足以抵消这项成本。

完整 MCU 深睡时序仍应实事求是地标注边界，未来若有真实固件具体失败再针对修复；冻结 legacy 对照足以支撑这一工作，不需要持续发布它。这里没有宣称两者对所有寄存器/模式达到硬件级等价，也没有改变用户此前豁免的真机/实体手柄验收范围。
