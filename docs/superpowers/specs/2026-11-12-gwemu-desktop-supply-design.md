# gwemu 桌面供电与冷启动

落实已批准迁移阶段一的桌面适配，使用已验证的 `build/gwemu-supply` 产物；默认 legacy、隔离目录、禁止 packaged gwemu、旧数据保护和 gwemu 即时存档禁用保持不变。

## Session 与运行状态

gwemu 专用严格 session schema 扩展现有 formatVersion 1，添加 `batteryPresent`，旧 gwemu 元数据缺省 true。legacy schema、exit state 和 JSON 输出保持原样；prepare/save 显式传入 kernel，禁止依目录名称猜测格式。presence 必须从原生严格读回，不能把缺失/错误值默认 true 后保存。百分比 0% 仍代表连接的电池。

AppState 的 status=running 表示已加载的活动 runtime；gwemu 另有 `devicePower`（battery、batteryPresent、usbPower、powered）和 `execution`（running/paused/unpowered），以及短暂 deviceOperation。不持久化暂停状态。无电源 session 加载完成时不发 cont、不等待首帧，保留 QMP/显示连接与 session lease。已供电 session 首次加载延续自动启动。恢复供电保持暂停，用户点继续后执行。

## 操作入口

仅 gwemu 显示设备菜单，普通窗口与时钟菜单均可用：电量增减、连接电池、USB 供电、暂停、继续、冷启动。动作 ID 为 `device.batteryDown`、`device.batteryUp`、`device.batteryPresent`、`device.usb`、`device.pause`、`device.resume`、`device.coldStart`，菜单 ID 与动作相同。菜单勾选由原生读回；无电源禁止继续/冷启动，暂停仅执行时可用。新增动作支持自定义热键，不新增默认绑定。现有 legacy 电量/USB 热键保持行为。渲染器显示暂停/无电源提示，屏幕无电源时遮盖旧画面，并禁止机身按钮；热键路由仍可恢复供电。

暂停：释放全部输入并等待提交，stop，读回状态。继续：检查 powered，cont，resetInput 后读回状态。冷启动是明确的“复位并运行”动作：释放输入、stop，先订阅 RESET，再发 HMP gnw-cold-cycle；验证文本返回，等待 RESET 并以 query-status 作为主循环完成屏障，随后 cont/resetInput。超时、断线、拒绝时不继续，清除监听器并报告错误；绝不以固定睡眠替代复位确认。

供电写入前只在原生 running 时发送释放；每次读写后更新 execution/power。原生只读状态使用 query-status 与严格 QOM 值验证，不为了读取而 stop。preflight 在关闭旧 runtime 前检查 battery-present/powered，旧产物应被拒绝。`powered` 是只读属性，不出现在机器 help：用 `-M none -S` 临时进程通过 `qom-list-properties` 的 typename=gnw-h7b0-machine 检查两者均为 bool，不初始化板卡或打开镜像；所有路径 quit/等待退出/清理端点。

## 并发与退出

所有供电/执行操作绑定捕获的 runtime，并串联到其 powerWork；排队即阻止新硬件输入。停止/换 ROM 标记 stopping 后禁止任何旧任务 cont 或更新新 runtime，退出等待已授权工作完成再严格 snapshot，随后 quit/退出/fsync/save。操作失败需重新读回实际状态，不能回滚供电来源或假报运行；无法读回时报告错误，关闭时仍采用 saveUncertain。输入 all-up 必须在停止/失电前完成，不向暂停 VM 发送标准 input-send-event，也不保留本地 held mask。

设备操作开始时重置 ControlRouter 并发布 input epoch，使 held/turbo 输入进入 quarantine，要求释放后重新按下；暂停/无电源时继续允许供电热键。读回失败清除 execution/power 或进入显式 unknown 子状态，同时禁用硬件输入、继续和冷启动；不能保留 stale running。保存时只选择 battery/usbPower/batteryPresent，不能写入派生 powered。

## 验收与边界

- 严格 schema：旧 gwemu 缺省 presence、absence 持久化、legacy JSON 完全不增字段、无效快照拒绝保存。
- 真实原生产物 controller：冗余来源切换不暂停，最后来源失去停止/清 RAM/TAMP，恢复仍暂停，显式继续，暂停输入释放，冷启动等待 RESET，关机重开无电源并恢复；源镜像不变。
- 排队操作与 stop/换 ROM/失败竞态，presence 快照故障保存不确定，旧构建 preflight 保留旧 runtime。
- Electron 隔离 ROM：菜单/提示/输入禁用、无电源关闭重开、恢复并继续、冷启动重新显示；legacy UI 回归。全部测试/类型检查/构建和独立 spec/quality review。

不增加管理端会话发现、GDB 接管、物理电池模型或完整 VMState，不宣称整体迁移已完成。父仓库仅本地提交，不推送或切默认内核。
