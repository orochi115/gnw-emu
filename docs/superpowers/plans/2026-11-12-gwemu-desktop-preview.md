# gwemu 阶段一：桌面开发接入实施计划

> **For agentic workers:** Use `subagent-driven-development` for native implementation and review, and `executing-plans` for integration. Steps use checkbox syntax for tracking.

**Goal:** 在显式开发启动模式中让 gwemu 复用现有桌面的实时帧显示、输入、静音和生命周期；使用隔离 session 并拒绝未验收存档/电源操作。

**Architecture:** 按已批准迁移设计执行阶段一下一批。旧内核仍是默认。`GNW_KERNEL=gwemu` 仅在未打包开发运行启用，并要求显式独立 `--user-data-dir=`（禁止默认产品数据目录及其子目录、符号链接/路径别名；在任何目录写入前解析已存在的祖先并核对隔离）；镜像与上游 sidecar 留在独立 gwemu session 命名空间。主控制器按固定 backend 能力调用标准 QMP 输入和新原生静音属性，帧继续使用 GNWF v1，不轮询 screenshot。关闭必须等待正常退出才记录 session，失败标记保存不确定。电量/USB 与完整即时存档仍未验收，明确拒绝操作并保留旧文件。

**Tech Stack:** QEMU display listener / QIO、C、TypeScript、Vitest、pytest、Electron Playwright。

**设计依据:** `docs/superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md` 与 `docs/research/2026-11-12-gwemu-baseline.md`。本批次不改变 .gnw.json schema、不实现阶段三发现协议、不切换默认内核、不发布主仓库、不归档旧 fork。用户已授权继续推进及独立公开 gwemu 仓库。

## 方案与边界

采用内核独立显示监听器，复用已验证的 GNWF 非阻塞传输与握手/背压，避免在 LTDC 模型引入网络职责。相比截图轮询，它保留现有流控和像素契约；相比整体复制旧机器，它只移植通用桥接。输入使用上游标准 input-send-event，保留既有多来源合并与串行队列；QMP 连接仍只由 UI 持有。

开发模式隔离数据且禁止 packaged 启用。保留两套内核仅供迁移对照。session 互斥由桌面 lease 与子进程原生 lock 双层保证。开发二进制固定使用本批次干净提交构建的 `build/gwemu-desktop/qemu-system-arm`，不自动选取旧基线产物。gwemu 无旧 battery/usb/state-file 契约，不能伪造这些属性已实现；只保留 session 的原电源配置，挂载镜像正常退出后同步到磁盘。存档入口显示能力限制，旧 slot 不读不覆盖。

## Task 1：原生桌面桥与身份

**Files:** gwemu `hw/arm/gnw_h7b0.c`, `hw/arm/meson.build`, new `hw/arm/gnw_h7b0_desktop.{c,h}` and frame/lock helpers; `hw/arm/gnw_h7b0_soc.c`, `include/hw/arm/gnw_h7b0_soc.h`; SAI1 C/header; parent `tests/test_gwemu_desktop.py`.

- [x] 先写真实内核失败测试：暂停时 GNWF 握手、RGBA alpha/尺寸、与暂停时 composed screendump 像素一致、ACK 背压及错误握手；UID 12-byte 合法/非法读回；同 lock 第二进程拒绝且不改镜像；音频-muted QOM 运行时可切换，WAV/确定性 PCM 证明非零输出→静音→恢复，并覆盖 voice 重建。
- [x] 用旧固定产物运行测试，记录缺少 frame-endpoint/UID/mute/lock 的预期失败。
- [x] 复用仅通用显示协议/锁实现，标明来源与 GPL；machine frame-endpoint/session-lock 在 SoC realize 前锁定、显示 realize 后监听。绑定实际 display surface（gwemu 当前 640×480），不改变其 LCD 模型。
- [x] 添加 SoC UID 显式 24 hex 配置，按 .gnw.json raw bytes 契约写入，保留默认合成 UID；设置必须在 realize 前，非法值报错。
- [x] 添加 SAI1 host audio-muted 动态属性，voice 创建/重建时保持静音；不改变 DMA/guest 时序。
- [x] 增量 build 与原生 tests 通过；保留基线容量回归。审查规格和质量后提交固定 fork，再选用全新 `build/gwemu-desktop` 目录构建最终 clean commit（sourceDirty=false）；最终测试/E2E 都指向此产物，不复用 revision 失配目录。

## Task 2：桌面 kernel 适配与隔离

**Files:** new `desktop/src/core/kernel-backend.ts`; modify `gwemu-command.ts`, `session-controller.ts`, `paths.ts`, shared contracts/locale and main menu capability gates as required; unit and integration tests.

- [x] 先写失败测试：开发 kernel 选择、打包/未知内核/默认目录与 symlink 别名拒绝；session 命名空间隔离；标准 QMP 按键变更/释放顺序；源路径不进 gwemu 参数；UID/frame/lock/RTC/audio 映射。
- [x] 添加 kernel backend，旧 QEMU 调用保持默认，gwemu 使用标准 input-send-event 差量，按键编码与既有 12-bit 顺序一致。
- [x] 桌面开发模式禁用 GDB（当前批次无管理客户端）；实验探针继续保留 GDB。启动使用 session 工作镜像、原生锁、固定/宿主 RTC 和后端音频；屏蔽影响副本/输入的环境自动化变量。
- [x] controller 启动/输入/静音/关闭走 backend。backend 在停止当前 ROM 之前 preflight 验证源容量、OSPI、UID 与产物能力；不支持容量/接线必须保留当前运行及 runtimeSessionId。gwemu 不调用旧 exit-state；正常 exit0 后将 session 镜像 fsync，再保存原电源配置；异常退出或强制终止仍标记保存不确定。原生 lock 失败须释放 lease。
- [x] AppState 标记即时存档能力；菜单禁用未验收 save/load/slots，快捷键仍提示 unsupported；电源动作提示 unsupported。旧 slots 不展示到 gwemu 命名空间。
- [x] controller 原生生命周期测试涵盖帧/按键 MMIO/静音/停止/重开/换 ROM/无效输入保留当前运行/lease，以及源 hash 不变。

## Task 3：桌面实测、发布与收尾

**Files:** `docs/desktop/gwemu-migration.md`, new `docs/research/2026-11-12-gwemu-desktop-preview.md`, parent gitlink, fork integration README.

- [x] 执行真实 Electron 开发模式 E2E：加载隔离 profile、绘制持续帧并检查非黑实际像素和人工截图、按键与焦点释放、静音、换 ROM/关闭、无残留 QEMU；必要时仅对执行 GUI/进程观察请求 sandbox 升级。
- [x] 记录 OFW UID/启动差异，不将帧可见视为音频质量或电源/存档验收；Flash-only/SD 对照用副本保留范围与失败项。
- [x] 运行完整 npm test/typecheck/build、原生 desktop 与容量测试、git diff --check；审查全部差异并修复实质问题。
- [x] 发布已授权 gwemu 分支固定提交，核对远程 SHA 后更新 gitlink；主仓库本地提交，保留 feat/gwemu-migration。

完成条件：真实开发桌面可通过隔离配置运行 gwemu，现有帧与输入工作，静音属性和正常退出持久化有证据，未验收能力被显式拒绝。完整阶段一仍需电源、冷启动/软件 SPI、完整 Flash 即时存档及全面音频/固件验收。

## 执行记录

本批次完成，详见 docs/research/2026-11-12-gwemu-desktop-preview.md。原生固定提交 f74441159ccbe2fd265affbb03cd26f655addfe3 已发布并核对远程 SHA；全新 clean build sourceDirty=false。15 项原生、139 项桌面、1 项 gwemu Electron 与 2 项旧内核 Electron 均通过。人工截图确认实际固件画面。审查发现的启动取消与地址覆盖问题均有回归并已修复，Electron override 路径误判已通过真实启动验收。主仓库当前批次本地提交；完整阶段一仍按上述门槛继续。
