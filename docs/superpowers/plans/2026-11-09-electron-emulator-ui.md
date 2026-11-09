# Electron 模拟器 UI 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:subagent-driven-development only if the user chooses delegation. Steps use checkbox syntax for tracking.

**Goal:** 实现现代、美观、跨平台的 gnw-emu 游戏主窗口，以及加载/制作 JSON ROM 配置两个菜单项。

**Architecture:** Electron 主进程运行 TypeScript 应用服务，管理 JSON 配置、输入、QMP 和独立 QEMU 生命周期。QEMU 使用单独的显示监听模块输出本机 TCP 完整 RGBA 帧；Electron utility process 接收，渲染进程 Canvas 绘制。Python 保留活跃 QEMU 测试与镜像工具，废弃应用层删除。

**Tech Stack:** Electron、TypeScript、React、electron-vite、electron-builder、Zod、Vitest、Playwright Electron；CSS tokens、系统字体与单一 SVG 图标风格；QEMU C、QIOChannelSocket、DisplayChangeListener、QEMU 音频 API。

---

## 授权、范围和使用方式

用户已确认架构、JSON 替换旧 TOML、废弃 Python 应用实现清理、主窗口/加载/制作流程，并要求 UI 美观现代。目前只授权讨论和规划，**不得执行本计划或创建应用代码，直到用户明确要求开始实现**。

设计依据：`docs/superpowers/specs/2026-11-09-electron-emulator-ui-design.md`。本计划细化的 TCP ACK、字段布局、模块路径和测试安排，不改变第一阶段业务范围。机身外观、设置页面、改键页面、手柄页面、调试窗口和最近打开菜单不实现。

先在独立开发分支/工作区执行，保留用户未跟踪的 `.superpowers/` 和既有 UserData。一次任务完成后作相应提交；生成的 dist/node_modules/截图不提交。依赖在实现时选稳定版本并写 lockfile，本次不下载或安装。

## 文件职责

| 路径 | 职责 |
|---|---|
| `desktop/package.json`, `electron.vite.config.ts`, `tsconfig*.json` | 开发/构建/测试入口，主进程、preload 和 renderer 分别构建 |
| `desktop/src/shared/{contracts,frame-protocol}.ts` | 业务 IPC 类型、与 C 对齐的帧协议常量 |
| `desktop/src/core/{schemas,profile-store,session-store,settings-store,atomic-file,paths}.ts` | 无 Electron 依赖的 JSON 数据与文件服务 |
| `desktop/src/core/{qmp-client,input-controller,qemu-command,session-controller,session-lease}.ts` | 控制通信、设备输入、命令参数、生命周期与独占 |
| `desktop/src/main/{index,windows,menu,ipc}.ts` | Electron 进程/窗口/系统对话框及受限业务接口 |
| `desktop/src/preload/index.ts` | 向界面提供明确的业务方法，不暴露任意 Node/QMP |
| `desktop/src/display/{receiver,frame-parser,delivery}.ts` | utility process 中的 TCP、解析和有界帧交付 |
| `desktop/src/renderer/{index.html,main.tsx,App.tsx}` | React 入口和主窗口状态布局 |
| `desktop/src/renderer/components/{GameScreen,EmptyState,MakeRomDialog,FileField}.tsx` | 画面、空态、制作表单及文件选择控件 |
| `desktop/src/renderer/styles/{tokens,app,form}.css` | 视觉规范、浅/深色、各状态与布局 |
| `desktop/tools/cli.ts` | 脚本共用的最小 profile/会话入口，不依赖 Electron 模块 |
| `desktop/tests/{unit,integration,e2e}/` | 业务/协议/生命周期与 Electron 场景测试 |
| `qemu-gnw/hw/arm/gnw/gnw_display.{c,h}` | 显示监听、像素快照、TCP 握手及有界发送 |
| `qemu-gnw/hw/arm/gnw/gnw_frame_protocol.h` | 显式协议字段及编码辅助，不发送原始 C struct |
| `qemu-gnw/hw/arm/gnw/gnw_session_lock.{c,h}` | QEMU 存活期持有的跨平台存档锁 |
| `qemu-gnw/hw/arm/gnw/{gnw.c,gnw.h,gnw_dma.c,meson.build}` | 小范围接入、退出 JSON、跨平台音频及模块编译 |
| `tests/test_display_transport.py`, `tests/test_exit_state.py`, `tests/test_session_lock.py` | 真实 QEMU 协议/快照/锁验证；沿用 pytest 驱动 |

源代码优先放在项目管理的 qemu-gnw 目录。第一版用机器属性启用显示监听，并以 `-display none` 避免原生窗口，无须修改外部 QEMU 的 display 枚举或提交子模块内部的新 UI 文件。该模块不承担硬件模拟。

## 固定的数据与协议决策

### JSON

新 `.gnw.json` 为平坦对象，必填 formatVersion=1、UUID id、model=zelda/mario、internalFlash、externalFlash；可选 bank2Flash、sdCard、sdWiring、deviceUid。省略 sdWiring 且有 SD 卡时默认 spi1。镜像路径相对配置文件，内部统一绝对路径。设备 UID 不是 profile ID。

session.json：formatVersion、battery、usbPower、rtc、batteryLifeMinutes、chargeTimeMinutes；默认值见设计文档。settings.json 仅包含 formatVersion、audio、realtime，缺文件用默认并按应用首次使用写入。拒绝未知版本和不合法字段类型，错误定位到用户可理解的字段。RTC 接受 host 或校验后的固定日期时间；路径含空格/中文/引号可用，QEMU 参数中的逗号需按 QEMU 选项转义规则处理并有真实运行测试。

开发默认 UserData 为项目根目录/UserData。发行版默认 Electron app.getPath('userData') 下的 UserData；便携模式通过显式 `--user-data-dir` 指定可写位置。各位置都由 paths 服务解析，不散落在组件里。QEMU 位于开发 build/qemu-system-arm 或发行 resources/qemu 下，Windows 加 .exe。

### 帧协议 v1

头固定 64 字节，整数统一 little-endian。magic 为 ASCII GNWF，RGBA8888 编号为 1，最大像素载荷为 16 MiB。帧序号用 uint64，TypeScript 使用 BigInt，不强制转换为可能丢精度的 Number。

| 偏移 | 字节数 | 字段 |
|---|---|---|
| 0 | 4 | magic |
| 4 | 2 | version=1 |
| 6 | 2 | type：HELLO=1、HELLO_ACK=2、FRAME=3、FRAME_ACK=4 |
| 8 | 4 | headerBytes=64 |
| 12 | 4 | payloadBytes |
| 16 | 8 | sequence：帧及其 ACK 用同一序号；握手为 0 |
| 24 | 8 | captureTimeNs：QEMU 宿主单调时钟；非帧消息为 0 |
| 32 | 4 | width：仅 FRAME 非零 |
| 36 | 4 | height：仅 FRAME 非零 |
| 40 | 4 | stride：FRAME 为 width×4 |
| 44 | 4 | pixelFormat：HELLO/HELLO_ACK/FRAME 为 1 |
| 48 | 4 | maxFrameBytes：HELLO/HELLO_ACK 为协商上限；其余为 0 |
| 52 | 4 | reserved=0 |
| 56 | 8 | reserved=0 |

只有 FRAME 有载荷，为 width×height×4 的 RGBA 字节，alpha=255；宽高为 1..2048。QEMU 连接后发送 HELLO，接收端返回 HELLO_ACK，之后才允许 FRAME。ACK 的其他字段为 0。未知类型/版本、不合法字段或超长消息报错断开，不分配异常尺寸缓冲。

最多一帧在发送或等待 FRAME_ACK，另保留一帧最新待发送。接收端完整接收后 ACK，Electron 内部另以显示消费确认限制交付，不把 ACK 当作游戏响应。帧序号递增可跳号，重复/倒序和未知 ACK 视为协议错误。双方启用 TCP_NODELAY；套接字缓冲仍计入性能测量。

显示启动采用机器属性 `frame-endpoint=127.0.0.1:PORT`；Node 接收端先监听随机本机端口，再启动 QEMU。QMP 也使用先监听的随机 loopback 端口，QEMU 作为连接方，避免抢占“先找空闲端口再绑定”的竞态。连接方向不改变 QMP greeting/capabilities 的角色。

## Task 1：建立桌面工程与契约

**Create:** desktop 的工程配置、shared 契约、unit/frame-protocol.test.ts、vitest 配置。此任务先无业务 UI。

- [ ] 配置 main/preload/renderer 三份构建及独立 CLI 构建；主进程 Node 环境、渲染进程浏览器环境，业务 core 不引入 electron。
- [ ] npm scripts 固定 dev、build、build:cli、typecheck、test、test:e2e、package:dir；提交 lockfile，dist/node_modules 加忽略规则。
- [ ] 为以上 64 字节协议写有效/非法头的测试；覆盖 uint64 精度和双方相同的固定字节样例。
- [ ] 实现协议声明、编码/解码和 IPC 请求/事件类型，约束 runtimeSessionId/requestId。
- [ ] 验证 `npm --prefix desktop run typecheck` 与 `npm --prefix desktop test -- tests/unit/frame-protocol.test.ts`，预期退出 0；提交工程与契约。

## Task 2：JSON 和原子文件服务

**Create:** core 数据/文件服务；tests/unit/schemas.test.ts、profile-store.test.ts、session-store.test.ts。

- [ ] 先写业务测试：版本/类型错误、UID/SD 条件、相对路径、特殊字符路径、默认状态、制作两次得到不同 ID、旧 TOML 拒绝。
- [ ] 写临时目录集成测试：旧镜像不修改、工作副本不覆盖、复制失败没有有效半成品、JSON 原子替换失败保留旧文件。
- [ ] 用 Zod 校验结构，用参数化 paths 服务定位资源/UserData；镜像校验对齐 gnw.c/gnw_flash.c/gnw_ospi.c 的真实边界，明确 Bank 2 ≤256 KiB，不虚构外部 Flash 只能 1/4 MiB 的限制。
- [ ] 实现新 profile、session/settings 保存；只有新格式会话可复用，不读取旧用户数据或自动迁移。
- [ ] 跑 `npm --prefix desktop test -- tests/unit/schemas.test.ts tests/unit/profile-store.test.ts tests/unit/session-store.test.ts`，预期全部通过；提交。

## Task 3：QEMU 完整帧显示模块

**Create:** gnw_display.c/.h、gnw_frame_protocol.h、tests/test_display_transport.py。**Modify:** gnw.c/gnw.h/meson.build。**Reference:** externals/qemu/include/ui/console.h、ui/egl-headless.c、io/channel-socket.c。

- [ ] 写真实 QEMU 测试：-S 启动后握手可完成、RGBA 颜色/背光与 screendump 对照、分包、错误握手、ACK、接收变慢时发送数量有界。
- [ ] 在机器完成设备创建后注册 DisplayChangeListener；frame-endpoint 未设置时不启用，现有 headless/Cocoa 不改变。
- [ ] 使用 QIOChannelSocket 和主循环可读/可写事件，完成 HELLO/ACK/FRAME/FRAME_ACK；非阻塞发送中持有自身快照，不引用被修改的 surface。
- [ ] 将刷新请求设为约 16–17 ms，调用 qemu_console_hw_update 得到新 surface，再转换为紧密 RGBA。首帧不依赖固件执行；不改 LTDC 的硬件时序/中断。
- [ ] 在 ACK 之前不提交下一帧给内核；更新最新待发送帧。断线/退出清理监听器、socket 和快照。
- [ ] 跑 `scripts/build.sh`，预期 build/qemu-system-arm 更新成功；跑 `.venv/bin/python -m pytest -q tests/test_display_transport.py tests/test_backlight.py`，预期通过或仅缺固件用例明确 skip；提交。

## Task 4：画面接收和有界交付

**Create:** display 模块；tests/unit/frame-parser.test.ts、delivery.test.ts。

- [ ] 写字节流测试：逐字节、多个头/帧粘包、半帧关闭、上限/溢出、握手顺序、序号和尺寸变化。
- [ ] utility process 监听 loopback 随机端口并报告 READY；注册通信端点不依赖 renderer 已收到游戏帧。
- [ ] 完整解析后 ACK 网络帧。通过 Electron MessagePort 将完整帧交给 renderer，跟踪一帧在途与一帧最新待显示；不得把帧放入业务 JSON。
- [ ] 接收端等待绘制消费确认期间继续解析网络但只替换本地最新完整帧，不追加 IPC 队列。测量结构化复制成本，不假定 ArrayBuffer 在所有 Electron 进程边界零复制。
- [ ] `npm --prefix desktop test -- tests/unit/frame-parser.test.ts tests/unit/delivery.test.ts` 预期通过；使用真实 QEMU/慢消费测试验证内存及帧龄稳定；提交。

## Task 5：QMP 和输入控制

**Create:** core/qmp-client.ts、input-controller.ts、qemu-command.ts；tests/unit/qmp-client.test.ts、input-controller.test.ts、qemu-command.test.ts。

- [ ] 用本机假的 QMP 服务测 greeting、capabilities、并发请求匹配、异步事件、超时、断线和取消；服务只模拟协议，不模拟设备功能。
- [ ] 写输入序列测试：短点击按下/松开都发送、组合键、同按钮不同来源、自动重复、失焦释放、Ctrl/Cmd 菜单快捷键不变成设备输入。
- [ ] 实现默认映射：方向、X/Z、G/T/P/O、Return/Tab。电量-/=及 USB C 走 QOM 属性，范围和已确认状态处理集中在 core。
- [ ] 生成 qemu 参数数组，包括 -S、-display none、frame-endpoint、QMP、会话工作路径、退出状态路径、RTC、realtime/audio；环境一次性覆盖只保留明确需要的已文档化选项。
- [ ] 跑对应三个 unit 测试文件及 typecheck；再真实 QEMU 连按/组合键验证，提交。

## Task 6：存档独占与退出快照

**Create:** gnw_session_lock.c/.h、core/session-lease.ts；tests/test_session_lock.py、test_exit_state.py。**Modify:** gnw.c/meson.build。

- [ ] 先写真实进程测试：两个 QEMU 同会话第二个拒绝，启动器被杀但 QEMU 存活时仍拒绝，QEMU 退出后新会话允许，正常退出生成本次 JSON 快照。
- [ ] 采用两层保护：应用准备期间以原子目录租约串行；QEMU 在打开工作镜像前持有 OS 独占文件锁，直至退出。机器属性 session-lock 指向应用传入的锁文件，QEMU 不认识 profile JSON。
- [ ] POSIX 用文件锁；Windows 用 LockFileEx 与 QEMU 打开的文件 handle。当前 QEMU Windows 通用文件锁并非已实现，不能把 qemu_lock_fd 在 POSIX 的成功当成 Windows 可用证据。
- [ ] 租约记录运行 token 和主控/子进程归属；不按时间过期自动删除活跃锁。启动器崩溃时保守保留，恢复仅在核实所有归属进程已结束后进行；归属不明时提示占用，不自动回收。用预先生成的 runtime token 对齐子进程和元数据，QEMU OS 锁为最终互斥保障。
- [ ] JSON state-file 保留现有退出 notifier，输出 formatVersion/battery/usbPower 到每次运行独立目录；写失败记录错误，应用不可把缺快照当成成功保存。
- [ ] 跑 `scripts/build.sh`、`.venv/bin/python -m pytest -q tests/test_session_lock.py tests/test_exit_state.py`；另在 Windows 真机/runner 验证锁；提交。

## Task 7：会话控制器和最小脚本入口

**Create:** core/session-controller.ts、tools/cli.ts；tests/integration/session-controller.test.ts、session-lease.test.ts。

- [ ] 使用可注入进程/QMP/接收端适配器写故障测试：无效新 ROM 保持旧会话、启动失败、握手/首帧超时、陈旧回调、连续请求 busy、显示断线、退出超时、保存失败。
- [ ] 实现状态机和唯一停止路径。通道握手完成后 cont，不先等固件首帧；cont 后有效帧到达再报告运行中。默认握手超时 10 秒、首帧 10 秒、正常退出 5 秒，可在测试中注入较短值。
- [ ] 正常退出等待 child 的退出及资源关闭，再验证本次 state.json 并原子更新 session；不要使用其他运行的快照。
- [ ] 所有回调带 runtimeSessionId；关闭/切换释放输入，关闭窗口等待同一停止流程。强制终止只在正常退出失败后明确处理，并显示保存状态不确定。
- [ ] 最小 CLI 支持生成新 JSON profile、查询 session-dir、启动窗口及解析 probe 所需路径；复用 core。脚本重跑生成配置时明确新 ID/存档策略，不隐式迁移旧 seed 文件。
- [ ] `npm --prefix desktop test -- tests/integration/session-controller.test.ts tests/integration/session-lease.test.ts` 预期通过；`npm --prefix desktop run build:cli` 输出 dist-cli/cli.cjs；提交。

## Task 8：现代主窗口、菜单和系统交互

**Create:** main/preload/renderer 入口、tokens/app CSS、GameScreen/EmptyState、tests/e2e/main-window.spec.ts。

- [ ] 使用原生窗口框架/控制按钮和 Electron Menu，实现平台菜单及 Ctrl/Cmd+O/N；开启 contextIsolation/sandbox，renderer 不直接使用 Node。
- [ ] 固定 renderer 只调用 preload 业务 API，main 负责系统对话框；关闭窗口/应用退出统一接入控制器。
- [ ] React 主界面呈现空闲/加载/运行/错误，Canvas2D 用 ImageData 显示 RGBA，imageSmoothingEnabled=false。Canvas 背缓冲以源尺寸设置，CSS 与实际像素缩放检查 high DPI，初期无需 shader。
- [ ] 主窗口初始游戏区域 640×480；原生菜单/标题栏另计。最小尺寸允许 1 倍画面或更小的可用区域，不要求窗口恰好固定 4:3。标题随 ROM 更新。
- [ ] 使用设计文档的 tokens、系统字体、单一 SVG 图标、操作系统主题与 reduced-motion。空态/加载态也是正式界面，运行态没有调试信息或侧栏。
- [ ] release-all 覆盖 BrowserWindow blur、系统菜单打开、系统对话框和制作窗口打开；各平台真实验证菜单生命周期事件，不能只依赖 DOM blur。
- [ ] 跑 `npm --prefix desktop run test:e2e -- tests/e2e/main-window.spec.ts`、typecheck/build；检查真实空态与游戏窗口，提交。

## Task 9：制作 ROM 表单

**Create:** MakeRomDialog/FileField、form CSS；tests/e2e/make-rom.spec.ts。**Modify:** main/windows.ts、ipc.ts。

- [ ] 创建有 parent 的独立 modal BrowserWindow，禁止游戏输入但不暂停固件；Escape/取消可关闭。模态窗口保留表单内容，取消系统保存对话框不清空。
- [ ] 单列表单分必需镜像、可选镜像、高级选项；UID 折叠，SD 接线有卡时启用。路径按一个统一 FileField 呈现，浏览通过 main 选择，支持长路径查看和复制。
- [ ] 写有意义的 E2E：必填校验/首次错误焦点、保存取消、缺失镜像、保存失败、后缀补齐、保存不切换、保存并加载只切换一次。系统选择器通过可注入适配器自动化，真实系统对话框仍人工验证。
- [ ] 使用现代 tokens，正文不显示参数名/UUID；按钮 loading/disabled、字段错误、keyboard focus/ARIA 完整。错误在失焦或提交后出现，不在第一下输入时闪烁。
- [ ] 保存创建新 UUID，原子写 JSON；成功关闭制作窗口，只有保存并加载触发控制器。退出制作恢复游戏焦点，不重放旧按键。
- [ ] 跑 make-rom E2E 和 profile-store unit；视觉检查浅/深色、长路径、错误与加载状态，提交。

## Task 10：跨平台音频和构建

**Modify:** gnw_dma.c/gnw.h/meson.build、scripts/build.sh；**Create:** desktop/electron-builder 配置、docs/desktop-build.md。

- [ ] 将宿主播放改为 QEMU 音频 API，保留 SAI/DMA 样本生成、虚拟时序和 WAV 输出。正确处理采样率变化、双声道、欠载与有界缓冲；不将 PCM 发到 renderer。
- [ ] 音频任务写/复用样本序列回归，比较修改前后 WAV，确保固件时序未因宿主音频改变；移除实际废弃的 AudioQueue 路径和对应 Apple-only 链接。
- [ ] 构建按宿主选择音频依赖及 QEMU 二进制路径；用现有 Windows/Linux QEMU 构建方式验证 GNW 中的 POSIX-only 文件操作/线程等边界，作必要定向适配。
- [ ] 打包 Electron 与 QEMU、所需运行库；QEMU 放 resources 之外部可执行文件，不放入 asar。默认镜像不打包，profile 路径仍由用户选择。
- [ ] macOS/Linux/Windows 各自产生可启动目录包，验证加载/制作、声音、焦点和退出。缺平台执行环境时记录“未验证”，不得声称已跨平台完成；签名/发布不属于本阶段授权。
- [ ] 运行 build/typecheck、现有相关 pytest 与三平台人工检查，提交代码及构建说明。

## Task 11：清理废弃实现与脚本依赖

**Delete:** harness/profile.py、harness/launch.py、tests/test_profile.py、profiles/*.gnw.toml。**Modify:** profiles 新 JSON 示例、README.md、docs/profiles.md、scripts/run.sh/probe.sh/run_sd.sh/run_sd_update.sh、父目录 run_backup_emu.sh。

- [ ] 在新服务已可用后删除旧应用层；不提前删除依赖仍在使用的模块。重新生成 zelda/mario JSON 示例，不兼容旧 ID/存档。
- [ ] 将需要保留的 shell 入口改为最小 Node CLI/core 或明确退役；probe 保持测试隔离，SD 镜像制作 Python 工具继续使用。删除旧 seed/兼容迁移分支。
- [ ] 更新文档的路径/依赖/菜单说明及状态快照格式；Python 的 headless/pytest 仍可运行。父目录不是 Git 仓库，run_backup_emu.sh 的改动须单独记录，不能假装进入 gnw-emu 提交。
- [ ] 全量 `rg -n 'harness\.(profile|launch)|harness/profile\.py|\.gnw\.toml|session\.toml|settings\.toml' README.md docs/profiles.md scripts harness profiles tests ../run_backup_emu.sh`，预期活跃入口无残留。历史设计/计划文档可以出现说明性引用。
- [ ] 跑 `npm --prefix desktop test`、`npm --prefix desktop run build` 和 `.venv/bin/python -m pytest -q tests`；记录缺固件/SD 依赖的 skip，实际失败必须处理；提交。

## Task 12：性能、视觉与最终验收

**Create:** desktop/tests/integration/display-performance.test.ts、docs/desktop-validation.md；截图/数据放 out/ui-validation/，不提交真实固件画面。

- [ ] 自动化验证慢网络/慢绘制时各段队列有界、最新帧恢复、QMP 响应及尺寸切换。10 分钟运行中记录内存、有效帧率、丢帧和帧龄，区分静态画面与持续变化画面。
- [ ] 在 60 Hz 或更高刷新率显示器测持续变化画面，目标约 60 次有效更新/秒；记录输入到可见变化延迟分布，不能以 QMP ACK 或重复 rAF 次数代替。
- [ ] 实际查看浅/深色、系统菜单、空态、加载、错误、制作表单、禁用、长路径、窄窗口和 high DPI。普通文字对比 ≥4.5:1，键盘操作、焦点和 reduced-motion 可用；校对文案，不显示内部参数/调试日志。
- [ ] 逐个平台验证三项业务及关闭/切换/失焦、声音、源镜像哈希不变、工作存档复用、孤儿 QEMU 锁与错误退出。
- [ ] 最终执行 typecheck、build、全部 desktop 测试及相关 pytest 一次；测试通过后仅在新变更或新问题出现时重跑。
- [ ] 验收文档写明实际环境/结果、未验证平台、延迟实测及材料限制。未达到标准时修正或明确标注，不能只凭“功能能用”结束 UI 工作。

## 实施前审阅记录

本计划仅是文档，没有执行以上勾选项，也没有建立 desktop 工程。本地检查已覆盖协议/文件服务与生命周期任务的依赖、Windows 存档锁、三平台运行证据及现代 UI 验收。独立计划审阅已派发，但子代理收到不可读任务消息，未能完成；不将该结果记为审阅通过。实施前仍应复核计划，尚无编码授权。
