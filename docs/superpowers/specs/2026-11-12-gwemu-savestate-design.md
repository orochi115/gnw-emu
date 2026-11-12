# gwemu 完整即时存档与 Flash 回滚

日期：2026-11-12。范围：已授权迁移设计阶段一中的现有即时存档契约；不切默认、不归档旧库、不改产品 UserData。

## 已确认的问题与方案

隔离合成镜像的标准 file migration 已实测：SRAM 和没有文件 backing 的 bank2 恢复，文件映射 bank1/外部 Flash 未恢复。原因是 memory_region_init_ram_from_file / init_ram_ptr 不自动注册迁移 RAMBlock。JPEG 只序列化 regs，OTFDEC 缺少恢复映射，LTDC 缺少显示/timer 恢复，board power 和 SoC 启动控制也需要纳入快照。

采用 QEMU 完整 VMState 流和少量模型补丁，保留桌面既有事务流程。仅复制 Flash 不能恢复正在运行的 CPU/外设；使用 qcow2 savevm 不能自动覆盖目前 mmap Flash；复制 legacy 整套机器模型违反迁移方向。新格式与 legacy 明确分开。

## Native 契约

1. 显式 opt-in `instant-states=on`，默认 off；startup `state-id=<profile UUID>` 绑定 ROM/session 身份。QOM `/machine` `savestate-support` 返回空字符串、`sd`、`flash-size`、`disabled` 或明确拒绝原因。所有 SD（含两接线）拒绝；外部 Flash >64MiB 拒绝；实验 timing 模式本批拒绝，支持普通桌面模型。
2. `/machine` write-only `save-state` / `load-state` 接收绝对路径，要求暂停。Header 独立 magic/version、编译来源身份、profile UUID、bank/external geometry、UID 和 RTC clock/config policy。载入前校验头、长度和 payload checksum；旧内核格式/其他 ROM/不同配置在 reset 或 Flash 写入前拒绝。桌面另以实际 binary SHA256 拒绝不同构建。
3. 正确注册文件映射 Flash RAMBlock，保存原始 bank1/bank2/extflash；恢复后写回并同步当前 session 的原 inode，不能 atomic rename 脱离现有 mmap。RDP 字节/sidecar 随已恢复状态同步，失败报告错误。不可变 unlock baseline/初始 ITCM seed 属启动身份，不从当前 guest ITCM 捕获，不以其替代 Flash 回滚。
4. 覆盖 CPU/RAM/虚拟时间、已有外设状态、board 电量/USB/电池存在及充放电相位、SoC pending handoff/POWER timers。恢复供电字段只重建输入/执行门禁，不调用冷启动破坏已恢复 CPU/RAM。载入始终保持暂停；无供电点禁止执行。
   RTC 恢复保存时的日历及秒内相位：host clock 不能随虚拟时间回退，需重定位 host anchor，恢复后仍按宿主时间推进；fixed clock 随虚拟时间回退。INIT 暂存写入、shadow lock 和闹钟/wakeup 剩余间隔一并保持。
5. 专项补齐：JPEG 输入/解码输出/编码输出及 cursor，worker 在保存/恢复时必须同步或正确重建，不能留下旧结果污染；OTFDEC 从 raw Flash/寄存器重建 plaintext overlay，刷新翻译缓存；LTDC 重建显示/timers/shadow 并隔离旧 compositor job；SAI 丢弃宿主输出队列并从寄存器重建输出，宿主静音不回退。GPIO/OSPI 未完成事务及 IRQ/clock derived state 逐项审查，失败测试驱动补丁。默认运行行为尽量保留。
6. 保存失败不报成功；加载中途失败保持暂停，由桌面恢复点兜底。格式/构建兼容仅承诺同一 gwemu 产物/配置；不宣称跨 legacy 或跨版本可读。

## Desktop 契约

- gwemu 使用 `states-gwemu/`，manifest v2 包含 kernel/build SHA256；legacy `states/` v1 原封不动。时间列表可显示旧构建槽存在，读档明确提示不兼容；保存成功前保留原槽引用。显式覆盖当前 gwemu 槽才清理旧 gwemu 版本，不触碰 legacy 文件。
- 复用 0–9 槽/F5/F8/F6/F7/menu/toast 和 saveSlot/restoreWithRollback。支持边界按 native 回答，SD/64MiB 提示保留。载入前先建立完整恢复点，失败则恢复 CPU/RAM/Flash/电源；恢复点也失败则保持停止/禁用执行并保留文件。
- 状态操作与供电/冷启动互斥，先完成已经接受的设备操作再接受快照，或明确忙；所有操作绑定 captured runtime，换 ROM/关闭等待快照。关闭期间不得 cont。运行时先 all-up 再暂停；暂停/无电时不发送被 QMP 拒绝的按键事件。读取后刷新电源与 execution；是否 resume 取决于操作前执行状态、恢复后供电和 stopping。
- host 按键/重复 bookkeeping 可清理，但 native restore 不得无条件释放 restored guest GPIO 或取消自动 pending POWER pulse；输入 held/turbo 在状态操作开始时隔离，结束后要求物理松开再按；host mute 与 transport/连接不回退。

## 验收

先 RED，后 GREEN。合成循环固件核对 CPU PC/寄存器、SRAM、真实 Flash 编程/擦除（两个内部 bank 与外部）、退出重开文件内容、host/fixed RTC、电源相位/无电源、未完成 OSPI/HASH/JPEG、OTFDEC 解密 XIP、显示/音频恢复。

损坏/截断/错误 header、kernel/build/ROM/geometry/clock 不匹配、无权限 I/O、late load/rollback failure，必须检查状态与源安全。真实 Mario/Zelda OFW 与64MiB Flash-only Retro-Go 同进程重复恢复及进程重开后恢复；SD两接线和128MiB拒绝；Electron真实菜单/热键/暂停/断电/关闭操作、旧内核回归。只挂载副本，finally 源哈希检查，留下构建 manifest、日志和独立审查。原始/旧 session/旧 slots 不动。
