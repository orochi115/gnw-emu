# gwemu 阶段一：构建与同镜像基线实施计划

> **For agentic workers:** Use `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 固定 gwemu 源码，提供独立可追溯构建，并用 `.gnw.json` 的隔离副本取得旧内核/gwemu 对照证据，为桌面适配确定接口与机器模型补丁范围。

**Architecture:** 旧内核仍是产品默认值；新内核构建输出在 `build/gwemu/`。实验命令复用桌面的 profile 校验和 session 创建逻辑，两个内核各用新建临时目录，不读取或复用产品 UserData。探针通过 QMP 获取接口清单、寄存器与截图，并实际连接本地 GDB stub；结果明确区分“能够启动”“功能已验证”和“尚缺适配”。

**Tech Stack:** Git submodule、QEMU/Meson/Ninja、Node.js/TypeScript、esbuild、Vitest。

**设计依据:** `docs/superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md`。

本计划是阶段一的首个可独立验收批次，不能作为整个阶段一完成声明。阶段二备份迁移与阶段三会话管理分别制定计划。上游实际接口差异尚未实测，桌面桥接与补丁计划应使用本批次的结果，避免预先编造兼容承诺。

## 文件职责

- `.gitmodules`、`externals/gwemu`：固定上游来源和 commit，不移除旧子模块。
- `scripts/build_gwemu.sh`：独立构建与错误处理，禁止调用旧构建脚本或给新源码注入旧机器。
- `scripts/gwemu-build-manifest.py`：记录源码 revision、dirty 状态、配置参数、宿主工具版本、构建产物 SHA-256；复现来源可核对。
- `desktop/src/core/gwemu-command.ts`：实验参数映射，所有可写镜像只使用 session 文件；显式报告尚不支持的 UID/OSPI 等字段。
- `desktop/tools/compare-kernels.ts`、`desktop/tools/kernel-probe.ts`：对照入口和 QMP/GDB 实测；不进入桌面产品流程，不实现阶段三发现协议。
- `desktop/tests/unit/gwemu-command.test.ts`、`desktop/tests/integration/kernel-comparison.test.ts`：保护源镜像/隔离目录、参数与失败清理验证。
- `docs/desktop/gwemu-migration.md`：构建和实验操作说明。
- `docs/research/2026-11-12-gwemu-baseline.md`：固定版本、实测结果和后续接口缺口。

## Task 1：固定上游与独立构建

- [ ] 检查工作区和旧桌面测试基线；在 `feat/gwemu-migration` 分支工作，不改用户 session。
- [ ] 引入 `https://github.com/slash-proc/gwemu.git`，gitlink 固定为 `3bfce5fd26a402660a8526b3a7ffc92048c3966a`。使用 `git submodule add --depth 1 -b gnw-h7b0 https://github.com/slash-proc/gwemu.git externals/gwemu`，随后 `git -C externals/gwemu checkout --detach 3bfce5fd26a402660a8526b3a7ffc92048c3966a`。重现以 gitlink 为准，不运行 `--remote` 更新。
- [ ] 建立 `scripts/build_gwemu.sh`：默认源码为上述子模块，输出 `build/gwemu`；允许显式 `GWEMU_SRC`/`GWEMU_BUILD_DIR` 用于独立重建；指定 `arm-softmmu`、禁用 docs/werror/tools/guest-agent/vnc/legacy SDL2/GTK，不禁用 GDB。沿用 Homebrew pkg-config 选择。
- [ ] 检查源码 revision 与 configure 的退出码；不能因存在旧 build.ninja 而复用另一个源码/配置。构建元数据失配应报错，要求选择新的输出目录；源码 dirty 状态须记录。
- [ ] 构建成功后写 provenance manifest；至少包含 revision、配置参数、宿主系统/架构、编译器/Ninja/Python/pkg-config 版本、产物 SHA-256 与版本字符串。不要声称所有宿主依赖都已固定或构建字节可重现。
- [ ] 运行 `sh scripts/build_gwemu.sh`；再运行一次检查增量构建。`build/gwemu/qemu-system-arm --help` 应列出 GDB，`-M help` 应含 `gnw-h7b0`。

## Task 2：只绑定 session 的实验参数映射

- [ ] 先写失败测试：gwemu 参数不能包含任一 profile 源镜像路径；映射 bank1/bank2/extflash、SD、RTC、本地 QMP/GDB；逗号路径正确转义；尚未支持的 OSPI/UID 配置须显式失败。
- [ ] 运行 `npm test -- tests/unit/gwemu-command.test.ts`，确认失败原因是接口尚未实现。
- [ ] 实现 `gwemuArguments(profile, session, {qmpPort, gdbSocket})`：`-M gnw-h7b0 -S -display none`；用 `-global gnw-h7b0-soc.bank1-image=<session>` 等绑定工作副本；`-qmp tcp:127.0.0.1:<port>,server=off`；`-gdb unix:<socket>,server=on,wait=off`；RTC 采用现有契约；SD 采用 `-drive if=sd,format=raw,file=<session>`。
- [ ] 基于源码的 NOR 芯片表按镜像容量选择支持的芯片，不静默将所有镜像改为 64 MiB；不支持容量需显式拒绝。内部 bank 扩展行为记录在报告中。
- [ ] 运行单元测试与 `npm run typecheck`；既有 `qemuArguments` 和 profile schema 不改动。

## Task 3：安全对照探针

- [ ] 先写失败测试：入口复用 `loadProfile`；为每个内核建立独立临时 session；输出目录必须新建，避免覆盖已有结果；参数不接受既有 UserData；复制失败或启动失败可诊断并回收进程/监听器。
- [ ] 运行 `npm test -- tests/integration/kernel-comparison.test.ts`，确认预期失败。
- [ ] 实现实验 CLI：`node dist-cli/compare-kernels.js --profile <file.gnw.json> --legacy <binary> --gwemu <binary> --output <new-directory> --seconds 3`。验证参数后启动。输出报告记录输入镜像容量与 SHA-256、两个产物 SHA-256/版本、各自 argv 和实际错误。输入 hashes 在运行结束后重新检查。
- [ ] 探针采用独立 QMP 反向监听；启动 timeout、退出竞态、QMP 异常均应捕捉；stdout/stderr 上限受控。关闭先 QMP quit，限时后 kill 并 wait，释放所有监听器；失败也保存结构化结果。
- [ ] 暂停时读取 qom-list `/machine` 与 `/machine/soc`（不存在可记错误）；query-commands；CPU info registers；片内向量和 UID 的 pmemsave（只读）；然后 cont，等待约定的墙钟观察时间，再 stop 和 screendump。观察时间不是确定性游戏进度验收。
- [ ] 对 gwemu 的 GDB Unix socket 实际发送 RSP `qSupported` 并校验应答校验和；仅证明协议入口存在，不宣称 gnwmanager 后端全部兼容。
- [ ] 为同一组源镜像创建两份 session，运行前核对副本 hash。退出后记录副本 hash/容量；核对源 hash 未变。失败时保留诊断和 session 副本位置，不能默认为对照通过。
- [ ] 将入口加入 `build:cli`；运行上述两组测试、完整 `npm test`、typecheck 与 build。

## Task 4：实测与证据

- [ ] 对 `profiles/mario.gnw.json`、`profiles/zelda.gnw.json` 运行对照，分别存入新的 `out/gwemu-baseline-*` 目录。检查截图非空与 CPU 状态；截图/音频正确性需要专门验收，不能以生成文件代替。
- [ ] 对现有 Flash-only 与 SD profile 运行相同探针，记录具体源/容量/hash，包括 bank2。只用副本，容量大的 SD 可使用文件系统复制优化，但不得直接挂载源卡。
- [ ] 若某配置被映射器拒绝（如 OSPI），登记为未验证/缺口；不得静默降级接线或移除 UID。若缺少 Flash-only 测试夹具，报告所缺数据，不制造通过结果。
- [ ] 核对 QOM、帧/音频、RTC、UID、电源、SD 接线、Flash 持久化和即时存档的实际接口差距，逐项列出后续修改文件与回归检查。
- [ ] 写实验报告和使用说明；更新任务状态和发现记录。

## Task 5：审查与本批次完成条件

- [ ] 审查所有本批次差异，确保默认内核/产品 UserData/历史存档没有更改。运行 `git diff --check`。
- [ ] 最终执行 `npm test`、`npm run typecheck`、`npm run build` 与构建增量验证；报告真正执行的对照范围与失败项。
- [ ] 提交本批次变更；不自动发布或归档远程 fork。

本批次完成条件：固定源码已构建；可从宿主 `.gnw.json` 对两个内核运行隔离实验并取得哈希/接口/GDB/截图证据；失败项有定位证据，桌面仍可使用旧内核。阶段一退出门槛仍按设计原文执行。

## 后续阶段一批次（本计划不假定已完成）

1. 在 gwemu 的小范围产品适配层实现帧协议和音频/输入/QOM/退出状态，接入 `desktop/src/core/session-controller.ts`；需要内核改动时再基于固定版本建立 fork。
2. 核对 RTC/UID/电源与两种 SD 接线，补缺并以现有原生/E2E 测试对同镜像回归。
3. 以 CPU/RAM/全部所需外设/完整 Flash 回滚验收即时存档；补内核身份，跨内核旧存档拒绝且保留文件。
4. 完整桌面与 gnwmanager RAM 固件验收通过后，才进行唯一内核切换、旧 fork 最终 tag/历史说明与退出。
