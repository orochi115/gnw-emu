# gwemu gnwmanager RAM Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 固定 gnwmanager RAM 固件在隔离 gwemu 上完成真实邮箱、HASH、Flash 和介质管理验收。
**Architecture:** 复用 GnW/GDBBackend 与原生 TCG 测试 harness。先实际定位传输/寄存器和 HAL 失败，再对正确层最小修复，不引入阶段三 UI 会话协议。
**Tech Stack:** Python/pytest、ARM GCC、GDB RSP、QMP、QEMU C/VMState。

### Task 1: Artifact and baseline probe
Files: scripts/build_gnwmanager_acceptance.sh (if needed for repeatable source build), tests/harness/gnwmanager.py, tests/test_gwemu_manager.py, ignored out/gnwmanager-ram/ evidence.
- [x] 记录固定 manager/嵌套子模块 revision、源 dirty、编译器/ELF/bin SHA 与 Python 环境；现有命令 `make -j4 BUILD_DIR=$ROOT/build/gnwmanager-ram gnwmanager/firmware.bin`，独立 `build/gnwmanager-python` 安装同源码包。
- [x] 用现有 Native harness 去掉 qtest accel，保留观察 qtest socket；为每个实验创建只绑定 loopback 的独立 GDB endpoint。保证 finally quit/kill/wait、socket cleanup 和 source hash。
- [x] 最小实际 GnW/GDBBackend probe：寄存器 roundtrip、RAM write/read、reset/halt、固件 start+bounded IDLE，记录失败，不 monkeypatch 响应。
- [x] API worker与gwemu由父harness监督。`worker.communicate(timeout=budget)`规定完整总期限，捕获TimeoutExpired后terminate/kill并wait worker，再finally退出/kill/wait native及源hash；禁止timeout thread遗留或把无进展timeout当总期限。初始启动30秒/Flash180秒/SD240秒。加入模拟worker持续报告进展仍超时、断连和cleanup的失败回归。
- [x] 单独构建 manifest 与可复现 opt-in 命令。缺少本地真实镜像时显式 skip；合成测试不得静默 skip。

### Task 2: Required transport compatibility
Files if demonstrated: externals/gnwmanager/gnwmanager/ocdbackend/gdb_backend.py, externals/gnwmanager/tests/test_gdb_backend.py, tests/test_gwemu_manager.py.
- [x] 实际确认 xpsr16/25、MSP/active SP 与目标 XML；如有缺陷，写 RED fake-stub 测试与实际目标测试后修复寄存器识别，不凭静态假设变更。
- [x] 实测 advertised PacketSize 与多包 RAM 长度/错误；按失败证据补 checksum、断连/短回包/超时处理，避免无限重试。仅修本批必需功能，不实现 gdbserver 交接。
- [x] 错误路径不偷偷 continue/reset；确认真实 board 无电源门禁仍生效。记录与原始 backend 的兼容差异。
- [x] manager 单元与原生 probe GREEN、规范/质量审查；只本地提交必要 manager 修复，后续 fork 发布目标单独确定。

### Task 3: RAM firmware and Flash acceptance
Files: tests/test_gwemu_manager.py, tests/test_gwemu_manager_firmware.py; externals/gnwmanager/gnwmanager/{gnw,validation}.py及manager tests、native model files only for demonstrated defects.
- [x] 合成 1/4/64 MiB 和真实复制 Mario/Zelda/Flash-only 进入 IDLE，读取真实 capacity/erase-size、HASH/RTC/显示证据。
- [x] 外部 HASH 用read_hashes；SRAM及内部bank HASH用actualprogram/flash固件compressed/decompressed及sha256bank验证，与Pythonreadbackdigest对照。
- [x] actualGnW API内部双bank/外部擦除、压缩/未压缩编程；外部highlevel flash >256KiB跨context，用高可压缩和确定性不可压缩数据。单次program >256KiB应拒绝。
- [x] 三个bank负对齐offset、start=capacity/start>capacity、end越界、erase/program取整后越界、合法末块；外部HASH非法size/end；拒绝前不得提交erase/program ready，完整Flash副本hash不变。实际隔离probe先证实缺陷，再在GnW/validation RED/GREEN补必要检查，保留whole-chip语义。
- [x] 若失败，收集 PC/mailbox/MMIO/IRQ/日志，单点 RED/GREEN 修正确切外设；mutable 状态纳入现有 VMState，补失败路径与已有 savestate 回归。
- [x] 管理固件之后实际应用重启前，选未用范围或通过actualAPI恢复所有改动副本并核对预期bytes，再等待TCG/新帧；三类ROM finally源hash核对。
- [x] 相关 manager/native/真实固件 tests GREEN，独立规范/质量检查；原生本地 commit+clean rebuild（新输出目录，不污染旧产物）。

### Task 4: SD wiring and final closeout
Files: tests/test_gwemu_manager_firmware.py, docs/research/2026-11-12-gwemu-manager-ram.md, docs/desktop/gwemu-migration.md, plan/spec; necessary demonstrated manager SD driver/host error fixes in externals/gnwmanager/Core/Src/FatFs/user_diskio_softspi.c and gnwmanager/gnw.py, plus native SPI files for demonstrated receive availability/consumption defects.
- [x] 两种 SD 接线：actual manager ls/read/write/hash/delete 临时文件、chunk 和退出重开，卡及所有原始镜像只挂副本。用独立FAT工具核对卡上文件，区分guest读回与持久化写入；manager驱动逐块CRC/token处理与宿主saved error状态须按真实失败在正确层修复，不能用native虚假Nac延迟掩盖驱动错误。
- [x] 明确功能性 NOR/RDP/VBAT 限制，不把 manager boot/flash 当完整工具链。必要 native 变更回归 cold/supply/RTC/softSPI/savestate；桌面切换产物时运行能力预检与相应 GUI。
- [x] root 独立复测、最终审查、manifest/SHA/source/原 PID16603/无孤儿进程核对；报告实际 commands 和未验收项。
- [x] 已授权 native 发布若有变更；父仓库仅本地提交，默认 legacy。不退休旧库，不实现备份迁移或 UI 会话发现。

关闭记录：manager公开fork分支固定7a82d653f23b5e3b5802eb4ce1e5076f94aa379b，native公开分支固定ae00b68951ab44b0dffb265e3f61340d735a68e5，远程完整SHA均核对。最终干净产物169原生、197manager/harness（1既有可选fixture跳过）、26复制固件、217桌面、7实际Electron通过；能力预检/typecheck/build通过。最终审查APPROVED，独立23项通过；源10hash不变、仅原legacyPID16603。详细产物SHA、命令及限制见[验收报告](../../research/2026-11-12-gwemu-manager-ram.md)。
