# gwemu 当前会话管理实施计划

> **用户最新执行规则（覆盖本计划和技能中的旧审查循环，2026-11-13）：** 按原定目标验收并复用有效证据，不新增完成门槛。只有具备具体触发、代码证据、实际严重后果、且违反既定需求的 Critical/Important 问题可以阻塞。其余意见仅记录最终报告，不修改、不加测试、不阻塞。修复后只复查原问题及直接回归，不重复开放式全量审查求 APPROVED。重大范围变更交用户决策；实机/实体手柄豁免及既有发布/保护授权不变。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。按用户最新规则安排实现与有限问题复核；已有持续执行授权，不需重新选择执行方式。

**Goal:** manager 默认发现桌面正在运行的 gwemu 会话，独占且有时限地执行完整设备管理，并安全交接外部 GDB。
**Architecture:** Electron 拥有 native 子进程与唯一 QMP。私有 Unix RPC 授予绑定连接和 runtime UUID 的 lease，lease Unix proxy 独占转发 native GDB；Python 心跳独立运行，所有设备命令使用同一 lease。离线命令不发现设备，明确的物理 backend 保留。
**Tech Stack:** TypeScript/Node net/fs、Vitest、Electron/Playwright；Python3.13 socket/threading/Cyclopts/pytest；固定 gwemu TCG 与真实 RAM manager。

规范：`docs/superpowers/specs/2026-11-13-gwemu-session-manager-design.md`，独立规范审查已通过。原始三阶段设计仍为总目标。实机/实体手柄豁免，其余验收不能替代为 mock。原十个镜像、真实产品 UserData、16603、旁 manager 和 `.superpowers/` 不动。父提交仅本地；manager 发布沿用已授权公开 fork。manager 完整 backup Task 1 结束审查前，不并发编辑 manager CLI/GDB 共享文件。

## 确定接口（双方使用相同 fixture）

目录：POSIX 使用 `/tmp/gnw-manager-${uid}`，无其他 tempdir 解释；owner UID/非 symlink/目录0700，失败拒绝，不 chmod 别人目录。短路径 native socket `n-${random16}.sock`，RPC `r-${serverId16}.sock`，descriptor `${serverId}.json`，lease proxy `l-${random16}.sock`。Unix socket chmod0600；descriptor 原子写0600，退出只删本实例自有文件。Windows不发布当前会话服务，UI明确状态提示；显式 standalone backend 不受影响。

Descriptor 精确形状：`{protocol:1,serverId:string,pid:positiveInteger,endpoint:string}`。serverId UUID；endpoint 必须位于上述目录且文件名匹配本实例。Python先 lstat 检查 directory/descriptor/socket owner、mode、symlink，连接后 hello serverId 一致；不信任 PID 单独判断可达。只列可达会话，不自动删除 stale 文件。

每请求一行 UTF-8 JSON，最多65536字节（含换行），默认 RPC10秒总截止；press使用min(durationMs+10000, lease剩余绝对时间)毫秒，最长40000，超时必须取消并归零held input；最多16连接、每连接最多8 outstanding请求。请求 `{protocol:1,id:string,method:string,params:object}`，id 非空最长128。应答 `{protocol:1,id,ok:true,result:object}` 或 `{protocol:1,id,ok:false,error:{code,message}}`。稳定错误：`INVALID_REQUEST/UNSUPPORTED_VERSION/NOT_FOUND/STALE_SESSION/BUSY/LEASE_EXPIRED/NOT_OWNER/NO_POWER/UNCERTAIN/TARGET_UNSAFE/UNSUPPORTED/INTERNAL`。不回传 stack 或镜像路径。无事件协议；status主动读取。

Methods:
- `hello {serverId}` → `{serverId,protocol:1}`；`list {}` → `{sessions:SessionDescriptor[]}`。
- SessionDescriptor：`{sessionId,profileName,model:"mario"|"zelda",kernel:"gwemu",execution:"running"|"paused"|"unpowered"|"unknown",powered:boolean,capabilities:string[]}`。busy会话仍列出，capabilities含`manage/gdb/backup/device-control`；uncertain列出但拒绝acquire。
- `acquire {sessionId,operation:"read"|"manage"|"debug",timeoutMs:integer1000..3600000}` → `{leaseId,sessionId,gdbEndpoint,initial:{execution,devicePower},expiresAt:unixMilliseconds}`；默认300000毫秒，绝对截止固定。idle30秒，heartbeat间隔10秒。
- `heartbeat/status {sessionId,leaseId}` → 当前 descriptor、deadline；valid heartbeat 必须快速处理，不排在长 control 后。heartbeat只更新idle，不能延长绝对截止。
- `mark {sessionId,leaseId,managerUploaded:boolean,memoryWritten:boolean,executionChanged:boolean}` → `{session:SessionDescriptor}`；client在对应GDB写/上传/resume/reset之前同步发送（mark失败必须阻止GDB动作，已确认true的flag可在同一unsafe阶段缓存，不每个tinychunk重复RPC；成功warm/cold reset恢复ready后必须清acknowledged-mark缓存，保留累计completionflags，后续新GDB变更重新mark）（任一true置applicationReady=false且monotonic累计变化）。debug acquire保守applicationReady=false，外部GDB可能任意改变PC。mark不能将false还原ready，唯服务器己方warm/cold-start后可确认应用已回到reset入口。已接受press/resume从首await前至操作settled，与非空mark同步互斥；cold-start安全cont及执行确认阶段同样互斥，重叠mark返回BUSY且不得发送相应GDB动作；reset阶段仍可mark，由修改序号保证旧reset完成不能覆盖较新标记。
- `control {sessionId,leaseId,action,value?}`：pause/resume/warm-reset/cold-start 无value；battery value整数0..100；battery-present/usb-power 布尔；press value `{mask:integer0..4095,durationMs:integer1..30000}`。mask沿用desktop/src/shared/controls.ts现有12bit：left0/up1/right2/down3/a4/b5/time6/game7/pause8/power9/start10/select11，POWER为bit9；标准8游戏键及现有4辅助键均保持定义，不发任意QMP。返回 `{session:SessionDescriptor,devicePower}`。read lease禁止control；manage/debug允许。pause/resume记录持久的applicationExecutionIntent=paused/running；cold-start记录running，warm-reset记录paused，普通供电/press不覆盖intent。pause/resume不改变应用PC/RAM，不登记为需要reset的未知GDB执行。resume/cold-start/press要求有供电；resume要求applicationReady，unknownGDB恢复仅warm/cold-start；电源动作本身可断电且不会自动越过供电gate。press首先要求applicationReady=true（否则TARGET_UNSAFE，先通过己方warm/cold-start回到应用）；以当前pause基线先cont→确认可输入→设置mask→运行guest持续duration→仍运行时归零mask并QMP确认，给guest一个有限post-release观察窗口（实际采样counter证明释放可见）→stop回管理pause基线；completion恢复initial或显式intent。server已知temporary应用执行不登记未知GDB变更。press持键与释放必须真实guest可见，结束/撤销归零，不能留下held input。标准input-send-event在paused时拒绝，正常press先cont再按键；异常/断电时不允许为了keyup继续未知PC，使用下述native只释放host-held input接口，不改变CPU/RAM或恢复执行。stop/expiry取消timer且不得再cont；耗时QMP受剩余deadline限制。
- `release {sessionId,leaseId,completion:{success:boolean,managerUploaded:boolean,memoryWritten:boolean,executionChanged:boolean}}` → `{session:SessionDescriptor}`。所有字段必填，不接受未验证的partial形状。backend写内存/寄存器、GDB resume/reset，GnW.start_gnwmanager都会登记相应变化；服务器独立保存mark累计变化、applicationExecutionIntent及applicationReady（己方control对应用的已知pause/resume/reset不与未知GDB executionChanged混淆）。successful且客户端/mark累计任一变化或服务器判断applicationReady=false先 stop→system_reset→stop（保持QMP顺序，native RESET后query确认）再按applicationExecutionIntent（若未设置用initial execution）及当前powered恢复cont；pure raw或仅己方设备control不reset，恢复显式intent或initial execution。extern debugger可能改变寄存器/PC，client保守报executionChanged=true；manager已上传则applicationReady=false。无供电不cont。abnormal/failed/missing completion保守stop并uncertain，恢复仅close/reopen。proxy在恢复前关闭且等正在进行的control有限完成/取消；native GDB upstream断连必须settled，再做QMP同步屏障确认停止状态，实际socket race验证队列写不能晚入应用，不能只用destroy(peer)当证据。

身份检查：所有leased method要求原始RPC连接===lease.owner、sessionId===原 runtime、leaseId一致、未超idle/absolute截止；每个await后再检查。release先置closing防止新control；旧cleanup只能清自己的owner。stop/childexit发controller revoke事件，立即断RPC/proxy，不等heartbeat。新ROM不会继承旧owner/endpoint。QEMU原生只有一个GDBclient，proxy第二连接明确关闭；先断前client才能重连。

## 文件与责任

- 新 `desktop/src/core/manager-protocol.ts`：具体类型、请求/动作校验、64KiB边界。
- 新 `desktop/src/core/manager-endpoints.ts`：私有目录/短Unix路径/自有清理；可测试directory注入只接受同等私有目录。
- 新 `desktop/src/core/manager-session-server.ts`：发现/RPC/lease期限/连接绑定/GDBproxy；调用controller接口，不直接QMP。
- `desktop/src/core/session-controller.ts`：runtime native endpoint、同步管理owner、门禁、原子admission/control/release；原生命周期仍归controller。
- `desktop/src/core/kernel-backend.ts`：warm reset/halt helpers、现有 constrainedpower/input，`kernelArguments`传递gdbSocket。
- `desktop/src/main/index.ts`：controller建立后startservice，退出先revokeservice再controller.stop；无ROM服务可list空，无native启动。
- 新 `externals/gnwmanager/gnwmanager/session_client.py`：发现、RPC reader、独立heartbeat、lease context和machinecontrol。
- 新 manager `cli/_sessions.py`：sessions/device-state/power/press；`cli/main.py`延迟auto backend上下文；`gnw.py`标记上传/变化和unlock模拟步骤；`cli/_gdb.py`外部调试交接；`cli/_unlock.py`和`cli/_lock.py`协调模拟电源步骤及保护生效冷latch。
- `ocdbackend/gdb_backend.py`：Unix、受控resume、真实recv剩余deadline；显式TCP维持兼容。
- 测试fixtures：新 `tests/fixtures/manager-session-protocol.json`，TS/Python共同读取合法/非法请求/descriptor/error样例；manager仓库在`tests/fixtures/session-protocol.json`保留同内容，独立checkout不依赖父路径，parent integration核对两份parity。

## Task 1：私有协议与endpoint单元

- [x] 建立共同fixture；先写 `desktop/tests/unit/manager-protocol.test.ts` 与 `manager-endpoints.test.ts`：版本/id/形状/未知动作/超大小、private目录symlink/mode/owner拒绝、自有cleanup不动peer、socket路径长度。
- [x] `cd desktop && npm run test -- tests/unit/manager-protocol.test.ts tests/unit/manager-endpoints.test.ts`，确认未实现失败；实现focused模块直到通过。
- [x] 单测验证Windows明确unsupported且不隐式TCP。typecheck通过后独立两级review，本地提交。

## Task 1b：暂停/断电时的安全host key释放

源证据：`externals/gwemu/ui/input.c::qmp_input_send_event`拒绝非running/suspended状态，controller原load也明确注释该限制。正常press必须cont之后设置mask；lease失效或断电时不能为了key-up继续任意PC。新增小型仅释放host-held keys接口，不扩大一般输入/执行权限。

Files：`externals/gwemu/hw/misc/gnw_h7b0_gpio.c`、`include/hw/misc/gnw_h7b0_gpio.h`、`hw/arm/gnw_h7b0_soc.c`、`hmp-commands.hx`；父`tests/test_gwemu_manager_input.py`，桌面`kernel-backend.ts`专用helper与unit。
- [x] RED实际TCG/QMP：cont→按组合含POWERbit9→stop，标准keyup确认拒绝；新`gnw-release-host-input`在pause/unpowered成功，GPIOhostflags与按键输入恢复idle，PC/SRAM/Flash不变、仍不running。下一次真实cont→同key按下不被旧hostrepeat状态吞掉。cold/unlock自动POWER不是hostpress，不被host-onlyrelease取消。
- [x] GPIO新增`gnw_h7b0_gpio_release_host_input`：只遍历host_buttons=true项并清hostflags；与独立保留的非host按键源合并，仅有效电平改变时调用已有set_button边沿，避免重叠POWER提前释放。不改guestGPIO配置/CPU/RAM或取消计时器/自动脚本事件；返回清除的host源数量。自动源虚拟状态随snapshot保存/恢复并在冷reset清理；正常宿主keyup与自动release也保持另一活动来源。增加真实冷启动POWER重叠RED/GREEN及timer/state/handoff相关回归。SoC沿已有cold-cycle注册风格提供HMP`gnw-release-host-input`，无args，reply固定`GNW host input released: N`，非本机失败；UI唯一QMP调用固定命令，不透传客户端HMP。
- [x] 独立规范/质量review后nativecleancommit/新buildmanifest/授权publish；不覆盖原legacybinary。构建在新`build/gwemu-session-manager`，保持backup本批旧binary证据；相关power/input/GDB/RTC/回滚native回归。控制器actual测试指向新artifact。默认legacy产品不在此切换；explicitgwemu preview路径按必要集成更新或明确binary选择，但不伪称旧binary支持新cleanup。
- [x] KernelBackend.releaseHostInput验证有界reply并清自己的mask/releasePending，作为admission/abort/pressfinally的安全cleanup。供电gate仍约束cont/press；release只改变物理host输入，CPU完全暂停。回归paused/unpowered/inputoverlap、abortPC未知不cont。按键释放边沿需guest观察的正常路径仍先keyup再有限运行窗口再stop；异常路径只要求host输入idle，绝不承诺guest已经消费事件。

## Task 2：controller独占与状态恢复

- [x] 先写 `desktop/tests/integration/manager-controller.test.ts`，真实native并用deferred seam精确迫出竞态：owner在第一await前生效，acceptedpower/state完成后pause；load/snapshot/mute/input拒绝，stop始终允许。
- [x] 实现 `managerSession()`、`beginManager(sessionId,owner)`、`managerControl(owner,action)`、`endManager(owner,completion)`，controller发`manager-revoke`携身份。nativeendpoint在load分配，所有失败/stop仅清自己的path。options允许endpoint目录供隔离测试。
- [x] acquisition先等待acceptedpower/state完成，读取initial execution/device状态（在stop之前），再release held keys/flush/pause/read；await后逐次核身份。managerControl串行且deadline；press撤销必归零；真实guest按钮采样计数器证明running/paused初态均观察按下与释放，结束恢复executionintent；unsafe目标禁止press；所有普通入口加owner守卫，已有power/state finally不能清掉manager设备operation标记。
- [x] 真实TCG测试rawonlyrelease保持PC/RAM/旧running状态、running→pause退出后仍paused且PC不变、paused→resume退出后仍running且无reset；manager内存写后release reset回bank1应用；unpowered不cont；abort暂停unknown；close/reopen恢复且不会错误宣称保存成功。
- [x] `npm run test -- tests/integration/manager-controller.test.ts tests/integration/gwemu-supply-controller.test.ts tests/integration/gwemu-savestate-controller.test.ts tests/integration/startup-cancellation.test.ts`；独立规范/质量review后提交。native测试不得skip，缺binary是失败。

## Task 3：RPC服务与managed GDB proxy

- [x] 写 `desktop/tests/integration/manager-session-server.test.ts` realUnix sockets：空list/multi identities/handshake、fragmentedJSON/oversize/maxconnections、跨连接盗lease拒绝、同lease一GDBclient/断后重连、release旧endpoint失效。
- [x] 实现serverstart/close、descriptor，短path managedproxy使用双向pipe、backpressure/errorcleanup；只在controller admission成功且复核身份后公布proxy。
- [x] 用注入时钟验证idle30秒与fixedabsolute截止；长press不会阻塞heartbeat，真实socket结合缩放duration验证>默认RPC截止的合法press仍成功，超绝对截止取消并归零；acquire过程中childexit/stop/failedproxy安全回收，oldcleanup不清新owner。
- [x] 真实nativeGDB读取PC/Flash，期间UI换ROM被拒绝；stop关socket，后续旧lease必失败；新load获新UUID/nativeendpoint。
- [x] main生命周期接入，`npm run typecheck` 与上述tests通过，再独立两级review/本地提交。

## Task 4：Python会话client与Unix GDB（backup实现结束后）

- [x] 写 manager `tests/test_session_client.py` 实socket服务fixture、共同JSONfixture：私有目录、stale、multi/no auto first、RPC fragmented/late/error、独立heartbeat长GDB命令不失效、固定totaldeadline、disconnectcleanup。
- [x] 实现独立reader thread按requestId派发、write lock，RPC等待只持pending状态不持心跳锁；daemon heartbeat可取消/join、异常保存给主操作检查。context退出显式release，异常completion=false；close本地socket不冒成功。
- [x] GDBBackend增加unix_socket与resume_on_connect=False；真实socket recv每次按remainingdeadline settimeout，避免buffered read(n)阻塞碎片拖延。test_gdb_backend.py加入持续慢碎片超deadline、Unix无TCP_NODELAY、原TCPdefaults回归。无需改真实物理backend算法。
- [x] manager全tests运行（`../../build/gnwmanager-python/bin/python -m pytest -q`），独立两级review，不提前发布未集成版。

## Task 5：CLI auto路由、完整命令、GDB交接

- [x] CLI tests先RED：defaultauto/sessions、--session多session显式选择、noUI错误不fallback、offlineverify/fetch和坏restore不发现不开backend；显式物理/GDB参数旧行为。
- [x] main共享lease覆盖多命令`--`与shell；backend_factory保持懒加载，先archive/confirm后acquire；backup捕获原始banks/extras前不resume/reset/mailbox。backend动作及managerupload在发送对应GDB动作之前同步mark，再记录completionflags（rawbackend write也记录），不要仅靠commandname推测。
- [x] device-state/power/press只调用machinecontrol；screenshot走现有managerGDB路径。unlock现有physical提示维持；session下把powercycle步骤映射cold-start，native gnw-cold-cycle已在guest虚拟时间750ms后发POWER，先观察实际blue-screen/payload完成，不能无条件再发第二个POWER。lock/reprotect也要cold-latch新RDP并读回确认有效后再报成功。重连同一proxy，不结束lease。覆盖manager.close/open过程中心跳持续。
- [x] gdbserver关闭自身GDBclient，给外部debugger同leaseUnixproxy（GDB `target remote /path/socket`）；gdb调用配置的ARM GDB argv，不shell。若支持现有port参数，仅显式lease-owned127.0.0.1桥接，serverlistener和client同lease期限，绝不公布native端点或自动TCPfallback。退出bridge/child后release，SIGINT/SIGTERM清理。
- [x] 测试真实外部GDB（先核可用ARM GDB路径）、read/write/step/breakpoint，第二client拒绝，退出后UI应用恢复；绝对截止导致断连并unknown。未安装GDB需解决可用工具，不能把mock当验收。
- [x] 全managertests、desktoptypecheck/unit与相关integration，按用户最新规则关闭原严重问题及直接回归，然后managercommit与授权fork发布核SHA。

## Task 6：真实Electron+完整manager工作流

- [x] 新 `desktop/tests/e2e/gwemu-manager.spec.ts` 和父 `tests/test_gwemu_session_manager.py`、记录 `docs/research/2026-11-13-gwemu-session-manager.md`；真实隔离UserData、copies/synthetic、ownedchild与有限workerdeadline。
- [x] list/select当前ROM→info/status→backup/verify/HTTPfetch/selectrestore→flash/readback→format/fs读写删→SD两接线→screenshot有效PNG→monitor/debug断点→unlock/reprotect与会话POWER供电流程。破坏性只针对新副本，锁定0xCC不可逆测试不进入实际源副本。
- [x] 演练manager途中UI close/nativeexit/leaseclient被终止、UIload/snapshot/input被拒绝、旧身份不会命中新ROM；正常manager退出回应用，运行/暂停/断电初态各测；无ROM不启动native。
- [x] 核对10源hash/旁manager/16603，记录所有执行数量zero-skips、实际binary/firmwaremanifest与ownedPIDs清理。实际GUI若sandbox阻止需按权限工具请求escalation。
- [x] Root 按原范围核对有效验收和来源 audit 通过、父本地提交；进入sole-kernel产品迁移与历史依赖退役计划。此计划结束不能将完整goal标complete。
