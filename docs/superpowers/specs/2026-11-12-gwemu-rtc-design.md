# gwemu 桌面 RTC 兼容修正

日期：2026-11-12。范围：迁移设计阶段一中已授权的现有 RTC 行为适配，默认内核仍为 legacy。

## 问题与选择

当前 supply 产物已复现：host RTC 暂停两秒后不走；固定时间推进后普通复位回到初值；固件写 TR/DR 无效。legacy 使用 QEMU rtc_clock，允许 INIT 校时且普通复位保留时间偏移。

采用显式能力参数修正桌面行为。只记录差异会留下已要求修复的功能缺口；直接改上游默认则影响现有固件与测试。因此保留默认虚拟时钟、每次复位重新播种和 sync-host 写入抑制，桌面启用新行为。

## 行为与接口

- RTC 新属性 `use-rtc-clock`（默认 false）选择 QEMU `rtc_clock`，而非固定 QEMU_CLOCK_VIRTUAL；日历、SSR、shadow、alarm A/B 和 wakeup 全部使用同一时钟。host 使用宿主本地时间，暂停仍推进；固定 UTC 使用虚拟时钟，暂停冻结。
- 新属性 `preserve-calendar`（默认 false）使普通复位保留日历 anchor，仍重置外设控制寄存器和取消 timers；首次启动照常播种。
- 桌面统一传 `use-rtc-clock=on,preserve-calendar=on,sync-host=off`。use-rtc-clock=true 且 sync-host=false 时遵守 INIT：进入时捕获并冻结日历；TR/DR 成对写入，在退出时一次提交，避免月末中间日期归一化；INITF 随 INIT。宿主当地校时使用 tm_isdst=-1。INIT 外 TR/DR 仍允许直接校时。进入 INIT 取消日历 alarm，退出重排，独立 wakeup 不冻结。INIT 中暖复位丢弃暂存写入，保留原 anchor。默认及只设置 sync-host=false 的旧行为保留。
- 完整冷启动、最后电源移除/恢复、preserve-calendar=true 时 RCC backup-domain reset 明确清除 RTC anchor/控制状态并重新播种，与 TAMP 清除一起处理；冗余供电变化不触发清除。固件执行后仍可校时：两组 patched OFW 备份丢失后设置 2021-01-01 12:00，模型应接受。重新播种仍是模拟器初始化策略，不是物理 VBAT 验证。
- session.rtc 继续表示启动配置。重开固定 session 从配置初值启动；host 从当前宿主时间启动。本批不新增关机时钟持久化，也不声称完成即时存档兼容。
- 既有 VMState anchor 字段名字保留，版本升至 6；新增初始化标志版本化迁移，旧版本恢复时设为已初始化，防止 load 后下一次暖复位覆盖时间。host 跨进程 load 的绝对 anchor 语义在完整 savestate 批次验收，本批不开放即时存档。

## 验收

合成隔离镜像测试固定时间跨月、SSR/shadow 一致性、暂停/运行、INIT 冻结及跨月成对校时、暖复位保留、冷启动/供电丢失/BDRST 重新播种、host 暂停推进和本地时区、alarm A/B 与 wakeup 清标志/中断门控。上游默认行为回归。

真实固件只挂载副本，覆盖四组镜像的 OFW/Retro-Go 启动和 RTC 读回（gwemu 验收 Retro-Go bank2；legacy 对照沿用既有基线，仅验证这两组镜像的 OFW 入口），实际 RTC 数值及启动后 INIT 校时均需断言，并记录源哈希。旧产物缺少属性时 QEMU 明确拒绝启动。桌面参数、native controller 和 Electron 现有供电/预览/SD/legacy 回归通过后固定新构建来源和产物路径。父仓库仅本地提交；不切默认、不归档旧仓库。
