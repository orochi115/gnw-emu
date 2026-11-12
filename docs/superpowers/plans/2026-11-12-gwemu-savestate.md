# gwemu Savestate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 保持既有完整机器状态及 Flash 回滚契约，并安全开启 gwemu 即时存档。
**Architecture:** 原生 opt-in QOM 接口包装完整 VMState 并补齐模型恢复；桌面独立格式/槽目录，复用恢复点事务与设备操作门禁。
**Tech Stack:** QEMU C/VMState/QIO、pytest/QTest/TCG、TypeScript/Vitest、Electron/Playwright。

### Task 1: Native Flash / snapshot foundation
Files: externals/gwemu/hw/arm/gnw_h7b0{,_soc}.c, new gnw_h7b0_state.{c,h}, hw/arm/meson.build, tests/test_gwemu_savestate.py.
- [x] 写 file migration 两端不同 backing 文件的回归，bank1/bank2/external应恢复 sentinel；当前产物先 RED。参考 out/gwemu-savestate/probe.py/log。
- [x] 正确注册文件 RAMBlock（POSIX/Windows）并检查 migration 生命周期，不重复注册普通 RAM 或 plaintext overlays。
- [x] 写 paused/absolute path、disabled/SD两接线/128MiB、独立 header/checksum/identity拒绝、CPU/RAM及Flash恢复/重开测试并记录 RED。
- [x] 增加 truncated/length/checksum 文件、save/load I/O/sync 失败及 header 拒绝后 CPU/RAM/Flash 不变的断言；host/fixed RTC 保存/恢复与 clock-policy mismatch 拒绝。
- [x] 实现 opt-in instant-states/state-id、save-state/load-state/savestate-support。用 QIOChannelFile/QEMUFile + qemu_savevm_state/qemu_loadvm_state；reset/yank/incoming cleanup按当前 API，错误保持暂停。Header校验在 mutation 前，actual binary SHA守卫在 desktop。
- [x] 实现 raw Flash原inode写回/sync及RDP sidecar flush，错误传播。支持默认非timing模式。
- [x] `ninja -C build/gwemu-fork qemu-system-arm`；`GWEMU_BINARY="$PWD/build/gwemu-fork/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_savestate.py` GREEN；规范/质量审查后 native local commit。


Task 1 基础范围已完成：原生本地提交 28dac42；独立规范/质量审查均通过，root 复测 113 项通过。默认 opt-in off，尚不启用桌面存档；真实 NOR/固件与 Task 2 外设验收待执行。

### Task 2: Native runtime / peripheral restoration
Files: SoC/board power/GPIO、OTFDEC、JPEG、LTDC、SAI及必要的既有模型头。
- [x] 检查逐模型 mutable 字段与 VMState，写 board supply/phase/pending POWER、OTFDEC、JPEG partially fed/drained/worker、LTDC fresh frame、SAI mute/output、pending OSPI/HASH 的失败测试。
- [x] 补齐版本化 VMState；只序列化 guest/runtime state，pointer/host连接重建；worker先同步，discard stale job epochs；post-load IRQ/clock/map/timer重建按完整load顺序。
- [x] power载入后更新ADC/GPIO/门禁而不cold reset；SoC initial immutable ITCM seed保留。
- [x] host RTC 日历/SSR 与闹钟剩余时间一致回退，按保存的clock anchor重定位；fixed虚拟时钟、INIT未提交写入及shadow lock恢复回归。GPIO unlock_handoff_active及queued CPU handoff不遗留跨读档回调。
- [x] 保存/读档及错误路径无 orphan worker/timers，GDB/QMP off gate不绕过。
- [x] 新测试 GREEN，既有 `tests/test_gwemu{,_desktop,_power,_softspi,_supply,_rtc}.py` 全过；规范/质量审查后 native local commit。

Task 2 已通过规范/质量审查与独立159项原生回归：2A本地6541c2f，2B本地830192d。桌面与真实固件仍未验收。

### Task 3: Desktop namespaces and compatibility
Files: savestate-store.ts、kernel-backend.ts、gwemu-command.ts、相关unit tests/locales。
- [x] v1 legacy保留，gwemu states-gwemu v2 kernel/build验证、不同build可列出时间/拒绝load、失败保存不替换槽、rollback保留/清理测试先RED。
- [x] 用实际binarySHA作为 Runtime state identity；参数开启 instant-states及profile UUID，preflight能力在停止活动ROM前检查。
- [x] 支持namespace参数默认legacy，gwemu版本化manifest；新增incompatible提示，路径保持用户可定位。
- [x] 原生能力严格检查类型与访问方式：-M none 查询类型；不挂载任何镜像/session 的暂停匿名板用 getter/write-only 拒绝与相对路径错误验证访问（QMP metadata 不含访问 flags）；runtime savestate-support 仅空字符串允许，sd/flash-size分别提示，disabled/timing/未知/非字符串 fail closed。
- [x] Vitest targeted GREEN；旧 v1 tests不改行为，审查。

Task 3规范/质量审查均APPROVED，root独立186项/45文件通过，typecheck通过。Task4尚未启用。

### Task 4: Desktop lifecycle and native acceptance
Files: session-controller.ts、main/index.ts/control gating/menu、new integration/gwemu-savestate-controller.test.ts、e2e/gwemu-savestates.spec.ts、已有gwemu路径tests。
- [x] 写 running/paused/unpowered保存恢复、源状态回退、mutations互斥、stop/换ROM等待且无latecont、error/readback unknown/rollbackfailure停止、input quarantine先RED。
- [x] 明确适配 post-load resetInput：暂停/无电时仅清理 host bookkeeping，不调用 input-send-event；native restore 清理 host 按键/重复 bookkeeping，保留 restored guest GPIO 与自动 pending POWER pulse，继续后允许标准 all-up；对应测试先 RED（含 pending POWER pulse 不被 all-up 取消）。
- [x] 解除gwemu拒绝分支，通过backend/store接口；deviceJobs/stateWork同一运行门禁；刷新power/execution，stop时不resume，无电point不cont；QMP暂停期间不发input事件。
- [x] runtime恢复点故障保持paused/执行不可用，保留恢复文件供排查；shutdown仍终止进程并报告不确定。
- [x] 排队换ROM在等待stateWork前登记可取消startup token；stop取消并等待，避免关窗后新ROM启动。使用独立operation owner，旧快照finally不能清掉新startup门禁，避免done/stop自等待死锁。
- [x] 接受存档时同步publish stateOperation隔离held/turbo，即使support/slot提前拒绝也要求松开再按。InputController与backend统一host-only reset/invalidate；router block/unblock、releaseInput/releaseChassis与迟到队列完成不能发暂停事件或覆盖新bookkeeping。
- [x] rollback failure/unknown readback 用captured-runtime持久uncertainty latch，关闭时仍清理child/display/lease并报告saveUncertain，不成功提交旧metadata；程序入口也不能resume/reset设备。
- [x] clean native build `GWEMU_BUILD_DIR=build/gwemu-savestate sh scripts/build_gwemu.sh`，更新开发路径。
- [x] 全部desktop unit/integration、typecheck/build；新Electron与既有supply/preview/SD/legacy回归。

Task4生命周期及四组补充竞态已通过规范/质量检查；最终审查发现 main 非运行状态误阻挡 USB/F5/F8，已修正并通过规范/质量及最终实现复审。217 项桌面检查及 typecheck/build 已通过。Electron 最初因 macOS 锁屏无法获得焦点；解锁后七组全部通过。最终验收通过；原生 gnw-emu 分支已发布830192d并核对远端SHA，父仓库对应提交仅保留本地。

### Task 5: Real firmware, final review and documentation
Files: tests/test_gwemu_savestate_firmware.py，docs/research/2026-11-12-gwemu-savestate.md、docs/desktop/{gwemu-migration,savestates}.md。
- [x] 三类copiedROM（Mario/Zelda/64MiB Flash-only）重复save/load、继续运行fresh display、进程退出重开load；真实flash变更回滚及finally source hashes。
- [x] native所有相关tests + power/RTC/cold/supply/软件SPI回归；新/既有Electron通过，source/slots安全与无任务进程复核。
- [x] 独立最终审查，实际binary hash/clean manifest和兼容结果记入报告，不宣称跨内核读档。
- [x] 已授权native发布，父仓库仅本地commit；默认仍legacy，保留历史session/states与旧repo。

本批完整存档与Flash回滚完成：clean native159、既有复制固件16、真实存档固件4、桌面217、Electron7项通过；十个源镜像哈希不变，原有legacy PID16603保留，无任务QEMU残留。manager RAM固件与阶段二/三未完成，不能据此切换默认或退休旧仓库。
