# gwemu Clock Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 核实已有 realtime 偏好和 gwemu 默认时钟的兼容边界，验收暂停/读档后不追赶暂停期间的墙钟。

**Architecture:** 细化已批准迁移设计阶段一，不引入快进功能，不复制 legacy icount 参数。桌面测试核对真实 kernelArguments 对两种设置的结果；原生使用合成临时镜像、真实 TCG 和已有 snapshot-clock VMState 采样。既有五固件音频证据仅作为互补，不将合成时钟验收当作游戏帧率或音频延迟验证。

**Tech Stack:** TypeScript/Vitest、Python/pytest、固定 ae00b68 产物 build/gwemu-manager-ram/qemu-system-arm。

沿用 feat/gwemu-migration；不修改产品 UserData/session、十原始镜像、旁 gnwmanager、PID16603 或用户 .superpowers。默认 legacy；父仓库只本地提交。备选是复制旧限速器（改变 CPU/外设时序且没有缺陷证据），或添加快进（超出原迁移功能）；推荐先验收默认宿主时钟并准确记录设置边界。realtime=false 在 legacy 关闭专用 icount/throttle，也不是承诺外设快进。gwemu 两种值当前均使用普通 TCG 时钟；保留偏好供 legacy 使用，是否需要独立速度控制另行设计。

### Task 1: Settings contract

**Files:** Create `desktop/tests/unit/kernel-clock.test.ts`; update `docs/desktop/json-format.md`。

- [x] 用独立临时合成 session，经 kernelArguments 读取真实镜像大小，对 true/false 分别验证 gwemu 参数相同、没有 -icount 或 realtime= 机器属性；legacy true 有 shift=2,sleep=off 和 realtime=on，false 无 icount 且 realtime=off。测试保留两内核音频设置的原有契约。临时目录 finally 删除。
- [x] Run `cd desktop && npm test -- tests/unit/kernel-clock.test.ts tests/unit/gwemu-command.test.ts tests/unit/qemu-command.test.ts tests/unit/settings-store.test.ts`。这属于已有行为验收，不制造假 RED 或修改生产参数。

### Task 2: Real TCG clock

**Files:** Create `tests/test_gwemu_clock.py`; reuse `backed`, `OPT_IN`, `save`, `snapshot_virtual_clock`, `prop`。

- [x] 移除 Native 的 qtest accelerator，显式 -accel tcg，保留 qtest socket 仅用于连接设施，不调用 clock_step/clock_set。合成客体执行循环，采样 SRAM 计数器证明运行、暂停不执行，并检查 guest-errors 日志为空；查询 query-status 保证运行/暂停前置条件。
- [x] 从暂停 snapshot 时间起，测量两个约 0.4 秒 active 区间，用 monotonic 在 cont 前与 stop 后包围实际区间；virtual/wall 比例在 0.85..1.15。paused 等待约 0.35 秒，连续 snapshot clock 必须逐纳秒相等；restore 早期 snapshot 后必须精确回退，恢复区间再次符合上述比例，不能包含暂停/未来时间。每个 QMP 操作既有 3 秒超时，Native 退出 3 秒后只 kill 自有子进程；整个测试外部监督 30 秒 timeout，失败后核查并回收自己的 PID。
- [x] 校验函数必须用半速、双速和暂停期间偷走时钟的负例证明断言有效；序列记录到独立 out/gwemu-clock，记录 args、binary hash 和 PID，不能覆盖旧证据。
- [x] Run `GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_clock.py tests/test_gwemu_savestate_runtime.py::test_tcg_global_virtual_clock_rewinds_then_continues`。失败先定位，不直接加 icount；若实证缺陷需要产品/native修复，另补 RED/GREEN 与相关回归、审查/独立构建/已授权发布。

### Task 3: Evidence and review

**Files:** Create `docs/research/2026-11-12-gwemu-clock.md`; update `docs/desktop/gwemu-migration.md`, this plan。

- [x] 检查 QEMU cpu_get_clock/cpus_get_virtual_clock 与 legacy gnw_realtime_tick，列出本地源码身份和普通 TCG/旧 icount 不同机制。结合已完成固件 WAV 结果，不声称每核心帧率/重负载/扬声器延迟已验证。
- [x] 运行上述针对性 tests 和 desktop typecheck。十源 hash 对照 out/gnwmanager-ram/source-before.json，产物 manifest/hash、两个子模块与旁 manager revision/status，ps 保留原 PID16603且无任务进程；独立审查测试和结论。
- [x] 全部通过后只提交本批测试与文档；native 无变化不发布。settings 文件及默认值保持，不声称阶段一全部通过。

关闭记录：计划与最终审查均 APPROVED；root 原生5passed2.27s、桌面21passed239ms/typecheck通过；独立桌面21passed236ms、负例及已有TCG4passed0.42s/typecheck。十源hash、产物/仓库身份、仅原PID16603审计通过。tests/docs-only，默认legacy，父仓库本地提交。
