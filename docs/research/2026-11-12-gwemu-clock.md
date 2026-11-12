# gwemu 默认时钟与 realtime 设置验收

日期：2026-11-12。范围：迁移阶段一的设置契约、真实 TCG 全局虚拟时钟及暂停/读档恢复；没有修改生产代码、原生模型或 manager。默认仍为 legacy，阶段一整体退出尚未通过。

`realtime` 在两个内核中不应照搬参数。legacy 的 true 开启 `-icount shift=2,sleep=off` 和机器 `realtime=on`：虚拟时间来自指令计数，机器每 1ms 检查并等待宿主时间；暂停恢复或落后超过 50ms 时重置基准。false 关闭这两项，回到普通 TCG，并不承诺游戏快进。README 中旧机器的非 icount SysTick 合并问题是它采用专用限速器的背景，不能只从全局虚拟时间正常就断言每个客体中断或游戏帧率正常。

当前 gwemu 对 true/false 生成完全相同的参数，不传 `-icount` 或 `realtime=`。普通非 icount TCG 的 `cpus_get_virtual_clock()` 回落到 `cpu_get_clock()`，由宿主单调时钟与 offset 组成；暂停关闭 ticks，时钟冻结；恢复重新建立 offset。这是现有行为，已记录为内核相关的兼容边界。已有偏好继续保存供 legacy 使用，本批不引入速度控制或把 false 改成快进。上游 `headless-capture.md` 也将 plain realtime 作为推荐，明确实验性 icount 不是加速开关。

本地依据：`desktop/src/core/{kernel-backend,gwemu-command,qemu-command}.ts`、旧 `qemu-gnw/hw/arm/gnw/gnw.c` 的 `gnw_realtime_tick`、固定 gwemu 的 `accel/tcg/tcg-accel-ops.c`、`system/{cpus,cpu-timers}.c`、`util/qemu-timer.c`。SAI 的 compatibility DMA 另有宿主音频队列背压；它与 timing-mode 的精确 DMA 不同，不能据此认定端到端音频或所有核心节奏已通过。

## 身份与运行方法

父仓库起点 `3718965a6ae4efdc49b0487b7af1323bf52e796e`，本地分支 `feat/gwemu-migration`。固定 native `ae00b68951ab44b0dffb265e3f61340d735a68e5`；干净产物 `build/gwemu-manager-ram/qemu-system-arm`，SHA256 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`，来源 manifest 不变。manager 固定 `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b`，本批没有原生或 manager 发布。

桌面 `kernel-clock.test.ts` 经真实 `kernelArguments` 和临时镜像大小读取验证两种 realtime 值、两种 audio 值；legacy 参数差别与 gwemu 参数相同均被明确检查，静音保留音频后端的契约不变。使用临时合成 session，不读取产品设置。

原生 `test_gwemu_clock.py` 显式 `-accel tcg`，合成 Cortex-M7 指令循环不断递增 SRAM。qtest socket 仅复用连接/内存读取设施，未调用 `clock_step` 或 `clock_set`。暂停后读取已存在的 snapshot-clock VMState，active 区间用 cont 前/stop 后的 monotonic 时间包围，排除状态序列化耗时。每区间计数器确实变化，暂停期间保持不变，读档时精确恢复；guest_errors 日志为空。外部 worker 有 30 秒截止，超时仅回收自身新进程组，原 PID16603 不属该组。原生设施另有有界 QMP 与退出等待。

## 实测与验证

| 区间 | 墙钟秒 | 虚拟秒 | 虚拟/墙钟 |
|---|---:|---:|---:|
| 初次运行 | 0.40695 | 0.406787 | 0.999588 |
| 暂停后继续 | 0.40402 | 0.403843 | 0.999556 |
| 回退读档后继续 | 0.40333 | 0.403175 | 0.999612 |

暂停约 0.398 秒（含暂停状态采样开销），前后虚拟时间逐纳秒相同：`406787000`。运行到未来后，读档精确回到同一时间和 RAM 计数器；恢复后的运行区间没有计入暂停期间或已回退的未来时间。0.85..1.15 的运行比例门槛另有半速/双速负例，暂停相等断言有偷走 350ms 的负例，均确认拒绝错误量测。

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  .venv/bin/python -m pytest -q tests/test_gwemu_clock.py \
  tests/test_gwemu_savestate_runtime.py::test_tcg_global_virtual_clock_rewinds_then_continues
cd desktop
npm test -- tests/unit/kernel-clock.test.ts tests/unit/gwemu-command.test.ts \
  tests/unit/qemu-command.test.ts tests/unit/settings-store.test.ts
npm run typecheck
```

本轮：原生及量测 5 passed / 2.27s；桌面 21 passed / 239ms；typecheck 通过。首轮 typecheck 发现新测试 Profile 缺少必填 path，补齐夹具后复验通过。未发现要求改变 gwemu 时钟的缺陷，因此没有生产修复或虚构 RED/GREEN。审查证据、实际 args/PID/hash、超时记录位于 `out/gwemu-clock/{plan-review.txt,tcg-clock.json,supervision.json,native-final.log}`。

此前五组真实游戏的 PCM/WAV 和 virtual/wall 结果见 [音频验收报告](2026-11-12-gwemu-audio.md)，作为独立互补证据，本批没有重复那些固件实验。全局时钟正确与采样音高正确仍不足以证明所有 guest SysTick 中断、每个游戏帧率、主机重负载节奏或 CoreAudio 扬声器延迟。需要这些产品证据后才能评估是否需要独立节奏策略，不能提前切换默认内核。

安全复核对照 `out/gnwmanager-ram/source-before.json`：十个原镜像大小/hash 不变，产物 hash 与 manifest 一致；两个子模块与旁 manager 均干净，旁 manager 仍为 `dec4fdc9cb027f4c0df4e18984ce2ae29ce28df2`。本轮 native 正常退出，仅原 legacy PID16603 保留；不涉及真机读写、产品 UserData/session/历史存档或用户 `.superpowers/`。完整备份及当前会话保护仍按原迁移设计分阶段验收。

最终独立审查 APPROVED，无阻断问题（`out/gwemu-clock/final-review.txt`）。独立桌面 21 passed / 236ms、负例及已有 TCG 4 passed / 0.42s，typecheck 和安全审计通过。父仓库仅本地提交本批测试与文档。
