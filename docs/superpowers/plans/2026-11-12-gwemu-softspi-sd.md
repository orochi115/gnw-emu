# gwemu 软件 SPI SD 接线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让现有 `sdWiring: "ospi"` profile 在隔离的 gwemu 桌面预览中使用 GPIO 软件 SPI SD，并验证真实 SD Retro-Go 挂载和镜像持久化。

**Architecture:** 复用 QEMU `ssi-sd` 和 `sd-card`；小范围 GPIO mode-0 位串行适配连接 PB2 CLK、PB1 MOSI、PD12 MISO，PE11 高电平选择 SD。启动属性选择 `spi1`（保持默认）或 `ospi`，同一卡后端只能有一个控制路径。GPIO 输入/输出模式决定有效信号；Flash AF 流量不能触发 SD。字节桥在完整 8 位后提交，响应排入下一字节，不能在首位预提交未知 MOSI。

**Tech Stack:** QEMU C/QOM/SSI、Python pytest/QTest/QMP、TypeScript/Vitest、Electron/Playwright。

批准依据：用户指定的迁移设计阶段一第 5 项及继续推进指令。继续使用现有 `feat/gwemu-migration` 隔离分支，不切主分支；公开 native fork 可发布，父仓库仅本地提交。

## Task 1: 原生 GPIO→SSI 适配及协议验证

**Files:** `externals/gwemu/hw/arm/gnw_h7b0.c`、`hw/arm/gnw_h7b0_soc.c` 及对应头文件；`hw/misc/gnw_h7b0_gpio.c`、`hw/misc/gnw_h7b0_spi.c` 及对应头文件；按需新增小型独立 bridge；`tests/test_gwemu_softspi.py`。

- [x] 先写失败测试：启动 `-M gnw-h7b0,sd-wiring=ospi`；通过 GPIO MODER/BSRR/IDR mode-0 发送 CMD0/8/55/41/58，检查初始化回复。
- [x] 验证 RED：`GWEMU_BINARY=build/gwemu-power/qemu-system-arm .venv/bin/python -m pytest tests/test_gwemu_softspi.py -x -v`，明确因缺少属性/行为失败。
- [x] 实现最小 startup-only 属性，拒绝未知接线；桥仅对有效 GPIO 输出时钟采样；输入 MISO 只驱动相关引脚，其他模式保留。SD 由现有 SSI SD 协议模型拥有，软件模式禁止 SPI1 同时消费后端。正常字节边界 CS 间隔必须保留已排队响应和已提交协议状态（真实固件每次单字节读都切 CS）；部分字节取消行为明确测试。第八个上升沿后当前 MISO 最后一位保持到固件读取 IDR，不得被下字节覆盖。
- [x] 覆盖初始化、单块读写、退出后重开、无卡、取消部分字节/CS、复位清除位计数、默认 SPI1 寄存器传输回归；另覆盖 AF 流量不提交、MODER 中途切换、重复高时钟与无关 BSRR。不得因桥复位而擦除 SD 数据；已提交的上游协议状态按实际能力说明。
- [x] 运行 `ninja -C build/gwemu-fork qemu-system-arm`，使用 `GWEMU_BINARY=$PWD/build/gwemu-fork/qemu-system-arm .venv/bin/python -m pytest` 再跑上述 tests 与 `tests/test_gwemu_desktop.py tests/test_gwemu_power.py tests/test_gwemu.py`。记录 RED/GREEN。
- [x] spec 与质量审查通过后提交 native；暂不 push。`docs/GNW_EMU_FORK.md` 解释线路、响应延迟和默认兼容性。

## Task 2: 桌面映射和会话隔离

**Files:** `desktop/src/core/gwemu-command.ts`、gwemu binary resolver/build path、`desktop/tests/unit/gwemu-command.test.ts`、`desktop/tests/integration/gwemu-controller.test.ts`（实际路径以仓库为准）。

- [x] 写参数测试，期望 `sdWiring=ospi` 生成机器属性，不再拒绝；现有 SPI1 和缺省 profile 明确映射。
- [x] 运行定向 Vitest 确认 RED，再修改映射；未知 native 能力仍在切换旧会话前拒绝。
- [x] 为两种线路验证隔离 session 卡读写/重开，原始 source hash 不变；不得开放 gwemu 即时存档。
- [x] clean native commit 后建立固定独立 `build/gwemu-softspi`，更新 desktop resolver，拒绝旧能力不足产物。
- [x] `GWEMU_BINARY=<absolute binary> GWEMU_DESKTOP_BINARY=<same> npm test`、`npm run typecheck`、`npm run build` 全通过。

## Task 3: 真实固件验收及交付

**Files:** `tests/test_gwemu_softspi_firmware.py`、`docs/research/2026-11-12-gwemu-softspi-sd.md`、`docs/desktop/gwemu-migration.md`，Electron 专用 SD 验收如需。

- [x] 在显式 opt-in 测试中复制本地 SD profile 的 bank1/bank2/Flash/SD。基于 ELF 符号检查 `VTOR=0x08100000`、`fs_mounted=1`、`sdcard_hw_type=3`（软件线路）；对 SPI1 检查 type=2。
- [x] 用屏幕与固件变量验收可浏览/运行已有 NES 游戏，覆盖卡读写或缓存/保存并重开；记录真实范围，不把 OFW intro 或亮像素当成挂载成功。
- [x] 所有源镜像哈希前后相同；失败或缺少夹具时明确记录，不宣称通过。
- [x] 运行 clean manifest 构建，原生 regression、真实 firmware、桌面全测试和 Electron gwemu/legacy 回归；检查无遗留进程。
- [x] 独立最终审查，更新计划/report，native push 并验证 remote SHA，父 repo 显式 stage 后本地提交；保留 `.superpowers/` 原样。汇报已交付与剩余迁移事项。

## 执行记录

原生 RED/GREEN 和两轮独立审查通过；真实软件 SPI 验收暴露 CMD12 残留读取计数/CRC，新增两种线路回归复现并修复，重新审查通过。最终 clean build `040b7e2`（sourceDirty=false），38 原生、145 桌面、4 电源固件、2 SD 固件、2 gwemu Electron、1 legacy Electron 通过。完整证据与夹具限制见 [实测报告](../../research/2026-11-12-gwemu-softspi-sd.md)。最终审查通过，原生已推送到公开 orochi115/gwemu 的 gnw-emu 分支并核对远端 SHA；父仓库按既定方式本地提交并保留 feature 分支。
