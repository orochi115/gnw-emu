# UI 自动化、日志与文档设计补充

日期：2026-11-09。依据：用户要求 UI 可被 Agent/脚本直接操作及读取、丰富可配置的 debug log、易查找且易维护的文档。本文补充 Electron 第一阶段设计；当前只更新文档，没有实现或运行以下接口。

## 1. 自动化接口选择

第一阶段采用应用内本地 JSON-RPC 2.0 服务及轻量 CLI 客户端。它们能够控制已运行的开发版或目录包 UI，不仅支持测试程序自行启动应用。Playwright Electron 继续用于独立 E2E 验证。MCP 后续可封装同一套 API，无须把应用核心依赖于 MCP 客户端。

选择理由：

| 方式 | 使用位置 |
|---|---|
| 本地 JSON-RPC + CLI | 首阶段正式自动化入口，Agent 可通过终端调用，脚本可直接请求 |
| Playwright Electron | E2E 中检查真实界面、浏览器事件、截图和可访问性，与业务服务测试分开 |
| MCP | 可选后续薄适配，调用现有控制/读取 API，不另维护一套业务 |

应用由 `--automation` 显式启用接口，HTTP `POST /rpc` 接收 JSON-RPC 请求，随机端口仅绑定 loopback；每个实例生成连接 token，并在指定的本次运行 endpoint 文件写入地址、协议版本和实例标识。CLI 通过 endpoint 文件连接同一个应用；正常退出移除文件，陈旧 endpoint/实例编号明确拒绝。普通启动不开放控制端口。自动化模式不修改应用业务流程，也不强制模拟对话框。

CLI 名称暂定 `gnw-ui`，支持启动带自动化接口的应用、连接既有实例、列出能力、提交命令、读取信息及等待状态。结果输出标准 JSON 到 stdout，日志写 stderr/日志文件；失败非零退出。命令名和参数契约统一由应用 API schema 定义，不依赖易变的 UI 文案。

## 2. 操作和读取契约

所有方法有 apiVersion、requestId；会话操作同时使用 runtimeSessionId，UI 使用 windowId。命令需要时校验界面 revision，避免在旧窗口/旧表单上操作。异步动作返回 operationId；通过查询/等待获得成功、失败或取消的最终结果，不能只凭请求被接收判定 UI 操作成功。带副作用的方法不因超时自动重试。

| 方法组 | 第一阶段能力 |
|---|---|
| `automation.capabilities` | 协议版本、当前可用方法、参数 schema、运行实例及模式 |
| `ui.listWindows` / `ui.inspect` | 窗口、标题、焦点、可见控件的稳定标识/role/label/value、enabled/visible、表单校验错误、加载阶段 |
| `ui.invokeMenu` | 按稳定菜单 ID 调用真实 Electron Menu 的同一 click handler，例如 file.openRom/file.makeRom；不是直接调用会话服务 |
| `ui.click` / `ui.fill` / `ui.key` | 在真实目标窗口发送点击、文本输入、按下/松开和快捷键，覆盖 React 事件、失焦及表单验证 |
| `ui.waitFor` | 等待窗口、控件可见/启用、文本/错误或业务阶段达到条件；有超时和取消 |
| `ui.screenshot` | 捕获实际 UI，包括画面/表单/错误状态；返回截图文件与窗口/显示帧关联信息 |
| `app.getState` | 会话状态、当前 ROM、设备属性/输入的请求与确认状态、最近操作结果 |
| `app.getDiagnostics` | QMP/显示通道状态、帧尺寸、最后接收/最后绘制序号、丢帧和队列计数、日志配置及文件位置 |
| `app.waitFor` | 按结构化状态和 operationId 等待；区分收到帧、已绘制帧、设备属性设置完成 |
| `logging.getConfig` / `logging.configure` / `logging.tail` | 读取/调整本次运行日志输出及查询有界的近期记录，支持级别/模块/会话/操作过滤 |

`ui.*` 必须走真实界面/控件事件路径。UI 信息从真实 DOM、窗口及呈现回报获取，不只从 core 中读取“预计应显示什么”。普通表单不得通过直接 setState 或直接写 profile 的方式实现 ui.fill/ui.click。稳定 data-testid/控件 ID 是测试契约，不向用户显示。

Electron 原生菜单调用属于语义 UI 操作，覆盖真实 menu handler，但不等同于鼠标展开系统菜单；各平台真实菜单/焦点行为另由 E2E 或运行验证覆盖。截图通过实际窗口 capturePage 获取，不以 QEMU screendump 代替；正常 DOM/UI 操作优先使用可访问性角色与稳定标识。

`app.*` 首阶段以信息读取为主。脚本已有最小 ROM/启动 CLI 属于应用服务入口，报告 source=app；自动化 UI 操作报告 source=ui。若未来开放直接加载/设备控制方法，必须保持这一来源区分，不能拿直接业务调用证明 UI 流程可用。

自动化操作复用主进程窗口管理、输入作用域和生命周期，不允许绕过 busy、窗口模态、失焦释放或会话锁。目标不存在/禁用/不可见、实例或会话过期、操作超时、应用停止等均返回结构化错误；查询有界，不无限返回日志或完整历史。

## 3. 系统对话框与可重复测试

默认仍打开真实文件选择/保存对话框。为了 CI 和 Agent 可重复操作，在显式测试模式提供 `test.queueDialogResponse`：为下一次指定类型对话框预置选择路径或取消。调用必须在点击 UI 之前完成，消费一次，随后仍执行同一对话框后续逻辑、校验和持久化。

这种替代只处理系统对话框的返回值，不伪造文件有效性、会话结果或 UI 验证。API/日志明确标记 dialogMode=native/scripted；真实三平台系统对话框仍有运行检查。脚本模式使用隔离 UserData、测试镜像和输出目录，不重置用户正常会话。

自动化等待使用事件和条件，不依赖固定 sleep。断线时应用中的已接受操作可能继续，客户端重连通过 operationId 查询，不能自动重发保存/切换操作。截图请求可指定等待 lastPresentedSequence 达到门槛，以避免捕获旧画面；该序号只说明 Chromium 已执行绘制/捕获路径，不代表显示器已经物理扫描输出。

operationId 查询通过 `automation.getOperation`，取消等待通过 `automation.cancelWait`；取消等待不隐含撤销已经开始的保存/切换。首次响应、操作终态和截图中的关联信息都来自同一实例，不能用客户端超时制造一个虚假的业务取消结果。

每次 E2E 失败保留截图、UI inspect、应用状态、最近结构化日志及操作步骤；记录被替代的系统对话框和缺失的原生验证。Agent 可以查状态定位问题，无须临时打开任意执行代码的 console。

## 4. 日志体系

应用使用 **Pino**，开发输出使用 **pino-pretty**；文件使用经过验证并锁定版本的滚动 transport。日志能力在工程早期建立，应用 core 不依赖 Electron，可以在测试/CLI 中注入同一 logger。

| 要素 | 规则 |
|---|---|
| 级别 | trace/debug/info/warn/error/fatal，默认 info；级别过滤含进程和模块 |
| 输出 | 开发可读终端；自动化/CI 为 JSONL；可选滚动文件，默认目录为 UserData/logs |
| 关联 | appInstanceId、runtimeSessionId、requestId、operationId、QMP request ID、windowId、sourceProcess/module |
| 字段 | timestamp、level、event、message、durationMs；错误保留 name/code/message/stack/cause，uint64 帧序号使用十进制字符串 |
| 控制 | 启动配置明确指定级别、模块和 sinks；自动化 diagnostics 读取，logging.configure 动态修改当前运行配置，不提供普通 UI 设置菜单 |
| 轮转 | 初始建议 10 MiB/文件、最多 5 份；按实测调整，不能无限增长 |

覆盖启动参数决策、profile 校验、副本准备、锁/租约、生命周期转换、UI/对话框、输入释放、QMP 握手/请求/事件/超时、显示握手/尺寸/背压/断线、音频初始化及保存/清理失败。

丰富日志不等于默认逐帧/逐采样打印。info 记录关键生命周期；debug 记录操作决策和耗时；trace 才记录必要的输入转换和协议细节。帧/音频高频事件默认汇总并限频，trace 的帧日志也有采样/输出上限，不能使低延迟路径等待磁盘或积压日志。

renderer/utility process 使用有界日志桥接，主进程统一落盘并标注来源；对通道丢弃计数和故障可诊断。QEMU 继续使用自身 qemu_log/error_report 等机制，stderr 按行接入 Pino source=qemu，保留原文及对应会话；不将每条 stderr 都错误地归为 error，不给 C 代码引入 JavaScript 日志库。

近期日志查询使用有界内存记录与 cursor，初始上限 2000 条、每次最多 200 条；返回被覆盖/丢弃计数，不扫描完整磁盘文件，也不宣称内存查询代表完整日志历史。滚动文件负责需要保留的历史。

不记录镜像/帧/PCM 原始内容、认证 token 或完整无限增长 QMP 载荷。诊断路径按用户需求记录，但认证信息始终过滤。日志 transport 失败需要可见的回退/错误诊断，默认不因日志文件不可写而让模拟器崩溃。

## 5. 文档和注释

建立独立入口 `docs/desktop/README.md`，由仓库 README 链接，至少包括：

- `architecture.md`：进程职责、输入作用域、状态机、错误/退出流程。
- `automation.md`：启用/连接开发及目录包、CLI/JSON-RPC 参数、操作/读取/等待/截图示例、scripted/native 对话框区别、错误与退出码。
- `logging.md`：级别/模块/sinks 开关、运行时调整、日志字段、轮转和故障定位示例。
- `frame-protocol.md`：64 字节字段表、像素/端序/单位、握手/ACK/背压、序号与时钟语义。
- `json-format.md`：ROM/session/settings/退出快照、默认值、路径规则、新 ID 与存档关系、旧格式不支持。
- `development.md` / `validation.md`：安装/构建/测试/目录包、三平台验证、性能与视觉验收、失败材料位置。

文档随对应功能提交，而不是在最后凭记忆补写。API 参数/schema 及稳定 ID 以共享代码契约为准，文档链接到定义；可执行示例纳入 smoke tests，避免文档与实际命令漂移。

代码注释解释非显然的原因和约束：socket 部分写入、ACK 与绘制的区别、跨进程生命周期、旧回调隔离、OS 锁和原子替换。导出控制接口及协议字段注明单位、失败和所有权；不逐行重复代码，也不在注释复制整套操作手册。

## 6. 第一阶段验收补充

1. CLI 能连接一个已经运行的目录包，读取真实 UI 状态，完成制作表单的填入/错误/取消/保存及菜单加载，等待最终状态并截图。至少一条完整 UI 场景通过 JSON-RPC 执行，不能全由直接 core 调用替代。
2. Playwright 独立 E2E 覆盖界面交互，自动化能力有稳定定位契约；系统对话框替代明确标记，原生路径仍单独验证。
3. 同一会话/操作可在 UI、主进程、接收端和 QEMU 日志中关联；能关闭 debug/trace、切换 JSON/可读输出并轮转；高频事件不产生无界内存或磁盘增长。
4. 文档入口可找到各接口与参数；至少一组已发布示例能在临时目录自动执行，日志/协议文档与 schema/字段表一致。

本文为用户新增需求的具体方案，尚未编码；MCP server、普通用户日志查看器和调试面板不因这些需求自动加入第一阶段。

此次文档补充做了本地一致性检查。此前独立审阅工具的任务消息传递异常尚未解决，本次不将独立审阅记为通过。
