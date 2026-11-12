# gwemu 当前会话与 gnwmanager 接入设计

实现原迁移设计阶段三。用户授权持续完成三阶段，实机与实体手柄验证明确跳过。当前UI保持加载ROM时创建子进程，无ROM不启动QEMU；不引入daemon，不破坏baseline/产品历史数据。

## 选择与职责

推荐UI发布用户私有Unix socket发现/控制协议，manager通过UI授予的独占lease连接GDB代理。只公布GDB端口会失去会话身份与冲突协调；直接第二条QMP连接不适用UI现有QMP监听职责。采用UI继续唯一拥有QMP，native GDB Unix stub位于自有短路径private目录，每次lease给新的Unix proxy，仅准一个GDB连接；原端点不在公开descriptor中。Windows命名管道与端点差异需明确支持或启动拒绝，不能悄悄暴露不受协调的TCP控制；本机目标为macOS，Unix实现Linux适用并测试。

UI私有发现目录默认/tmp/gnw-manager-<uid>（Python/Node约定使用系统temp，mac通过/tmp短路径），创建0700并检查owner/type，不允许symlink或其它用户所有。每UI实例随机serverId、RPC socket及0600registry JSON；文件包含protocol1、UI PID、serverId、RPC endpoint，无基线镜像路径。server socket0600；限制64KiB NDJSON、总request deadline、最大连接数；协议显式版本和requestId。客户端验证descriptor类型/UID/路径边界、handshake serverId一致，只列可达活动session，旧dead/stale端点不任意复用或删除。没有活动session提示启动UI/加载ROM，多个必须--session指定runtime UUID或明示选择，不能随便取第一个。

## 运行时身份与lease

每次原SessionController.load生成的runtimeSessionId就是设备身份；换ROM/进程重启改变。list返回{sessionId,profileName,model,kernel,execution,powered,capabilities}。不公布产品镜像路径。acquire必须指定sessionId和operation{read,manage,debug}，响应随机leaseId、独占GDBproxy path、初始execution/device snapshot。RPC连接生命周期绑定lease；所有control/release要求原sessionId/leaseId/connection同时匹配，永不转向新ROM。client每10秒heartbeat，idle30秒或显式total操作截止（最高1小时）撤销lease；deadline不因心跳延长。每lease只有一个同时GDB客户端，重连必须先断前一条，lease结束移除proxy并断转发。

SessionController.beginManager在第一次await前占owner，同步关闭输入/设备/存档/换ROM门禁，然后等待已接受power/state工作、release/flush held input、暂停CPU并读回powered/execution。初始化失败仅释放属于此次的owner；若设备未知标记uncertain。GDB连接不resume（managerBackend resume_on_connect=False）。lease期间拒绝load/即时存档/普通UI设备操作/静音和输入；管理专用动作在同一owner下经UI.backend/QMP串行执行。正常UI关闭可以撤销管理并关闭自己的child，客户端报告中断/部分完成。不能为了维持lease阻止用户关闭窗口。

失去lease、QEMU退出、换ROM、RPC断连或操作失败使所有旧GDB/控制失效。异常管理结束保守保持暂停并报告状态未知/部分完成；不得自动resume未知PC或显示保存成功。异常后的恢复明确采用关闭并重开，不宣称uncertain状态可冷启动。成功release根据明确completion字段选择：原始只读capture可恢复之前running/paused；上传/Flash/manager执行已改变RAM时先warm reset/halt回到应用再按原运行状态恢复；显式设备pause/resume意图在lease退出后保留，纯设备控制不应仅因执行状态变化重置应用PC；temporary manager/GDB变更仍重置回应用再恢复所选执行状态。无供电始终暂停。close/abort不越过电源执行gate。

## 协议动作与manager CLI

RPC methods:hello/list/acquire/heartbeat/status/mark/control/release。mark在manager上传/写/未知GDB执行之前登记目标不再是安全应用，debug lease默认同样保守；press/resume未知目标先拒绝，明确warm/cold-start恢复应用后才允许。标准QMP暂停时拒绝输入，所以press先临时运行已知应用，再发送按下及释放，使guest实际观察事件，再暂停回管理基线，退出恢复初始或显式执行意图。control限定pause/resume/warm-reset/cold-start、battery百分比、battery-present/usb-power布尔、现有12bit按键组合（标准八游戏键及pause/power/start/select，POWER为bit9，沿用产品映射）。screenshot使用现有manager GDB截图命令，在同一lease下将结果写到client自己选择的路径，不通过RPC传PNG或要求UI写任意文件。异常/断电释放host-held键采用native专用gnw-release-host-input（清host键状态及相应物理输入，不改变CPU/RAM/自动POWER或恢复运行），避免为了keyup继续未知PC。禁止任意QMP/HMP字符串/文件路径或qom属性透传。所有错误有stable code/message，session stale与busy区分。

manager新增session_client.py发现/RPC/lease上下文。CLI默认backend=auto用于当前UI session；明确--backend=openocd/pyocd/gdb保留旧模式，绝不因为发现失败偷偷连接物理probe。offline verify-backup/fetch-backup不发现/连接。--session指定身份；sessions列设备；device-state/power/press通过UI控制。所有涉及设备的manager命令在同一session lease内，GnW/GDBBackend携带machine_control上下文以协调unlock流程的模拟电源循环；不让旧连接自动命中新ROM。backup raw连接使用同一GDBproxy且不resume。

GDBBackend增加Unix socket参数和可控open，寄存器/XML/分包/error已有实现回归；command总截止要约束actual socket读，不能碎片延长。gdbserver/gdb模式关闭自身GDB连接后将lease proxy交给外部调试器，后台维持RPC心跳并确保只有一个client；退出撤销lease，不能保留无协调的端点。gnwmanager unlock完整路径保留原算法，session环境把其“拔电/屏幕蓝”步骤映射为UI cold-cycle和POWER、等待真实guest状态；实机模式保持原交互。

## 验证和依赖

新增desktop/src/core/manager-session-server.ts与tests unit真实socket、session-controller专用lease测试，main启动/关闭服务和state变化；gwemu arguments开启private Unix GDB，默认不向网络监听。manager session_client.py/CLI/GDBBackend协议单元验证错误/多session/stale/partialJSON/断连；父tests/e2e管理真实Electron隔离UserData+manager subprocess验证当前ROM自动发现、真实RAM manager、backup/restore/flash/filesystem/SD两接线、unlock/lock、debug交接、power和截图。用actual GDB lease证明失效旧连接和UI换ROM/关闭/snapshot/输入门禁；保存原图/源hash/identity及owned清理。

先完成backup模块及其规范/质量review，再接CLI共享文件；session RPC的独立实现可在desktop单独开发。默认kernel切換和旧fork退出另行最终收尾；本设计不是全部scope完成声明。物理设备、真实卡电气和实体手柄仅标记用户豁免，不宣称通过。

### Task1b 自动与宿主按键重叠修正（2026-11-13）

真实TCG复现：冷启动自动POWER保持期间再收到宿主POWER，host-only释放1却提前拉高引脚。host标记与自动源须独立保存；清宿主标记后由仍活动的非host源决定有效引脚，仅有效电平变化时走已有释放边沿，不能提前触发unlock handoff的非host释放。正常宿主keyup与自动timer释放也必须保持另一来源仍按住的电平；自动源的虚拟执行状态须随机器snapshot保存/恢复并在冷reset正确清理。新增真实重叠RED/GREEN、自动timer后续释放以及相关state/RDP回归，维持CPU/RAM不cont/reset与原releasecount含义。此为已授权host-only保证的证据驱动修正，不改外部协议。

### Task2 执行与标记互斥修正（2026-11-13）

独立真实原生审查复现：reset 完成覆盖较新 mark；press 等待确认/长按期间收到 mark 后继续对未知 SRAM PC 发送输入。reset 以修改序号确认没有更晚 mark 才恢复应用安全标记。已接受 press/resume 从首 await 前到最终状态确认及清理结束，与非空 mark 同步互斥；cold-start 在 reset 阶段仍允许 mark，确定安全 cont 后至执行确认结束采用同样互斥。重叠 mark 返回既有 `BUSY`，不得改变累计标记/修改序号/安全状态，调用方必须等待 mark 成功才能发送对应 GDB 动作。客户端仅可在同一 unsafe 阶段缓存确认；成功 warm/cold reset 后清确认缓存并重新标记新的未知变更，累计 completion flags 保留。v3 独立规范与质量复审均已批准，真实原生回归通过。
