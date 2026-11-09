# 进程边界与生命周期

| 进程              | 职责                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| Electron renderer | React 表单、Canvas2D 最近邻显示、实际 DOM 键盘事件；无 Node 权限                 |
| Electron main     | JSON、文件对话框、原生菜单、QMP、按键映射、会话独占、QEMU 生命周期、自动化与日志 |
| Electron utility  | TCP 分包解析、协议校验、ACK、最新帧交付；不解析应用配置                          |
| 独立 QEMU         | 硬件模拟、最终合成及背光像素、宿主声音、工作镜像持久化、退出电量/USB 快照        |

主进程通过 contextIsolation + sandbox 的 preload 提供有限业务方法；renderer 不访问 Node、任意 QMP 或任意文件。画面通过 MessageChannelMain 连接 utility 和 renderer，像素不进入业务 JSON。Electron 跨进程结构化复制有成本，不承诺零复制。

空闲 → 启动中 → 运行中 → 停止中 → 空闲。正常请求同时最多一个；重复操作返回 busy。所有运行关联 UUID runtimeSessionId，显示回调忽略旧运行。

加载先校验配置、镜像和 QEMU，再退出旧运行。因此新配置无效时保留当前游戏。校验通过后，旧会话退出、新会话启动失败时进入可恢复错误状态。

新运行先取得应用租约，准备工作镜像、本次 `runs/<runtimeSessionId>/state.json`，启动 loopback QMP 和 utility 显示监听，再以 `-S -display none` 启动 QEMU。QMP capabilities 和像素握手完成后设置 buttons=0、cont，然后接收有效帧。连接/首帧默认超时 10 秒。

停止是唯一保存路径：清空输入 → quit → 等待子进程退出（5 秒）→ 校验本次快照 → 原子保存 session.json → 关闭端点 → 释放租约。QMP 回包不是进程退出证据。正常退出失败会强制终止，显示“无法确认本次状态保存”，不读取旧运行快照，不删除工作镜像。关闭窗口等待正在进行的文件/启动操作和同一停止路径。

应用 `.lease` 使用 mkdir 原子占有，记录主控 PID/子进程 PID/token。恢复以 `.recovery` 串行核验，只有全部记录进程已退出才回收；PID 复用、归属未知、未写完的元数据都保守报占用，不按时间过期。QEMU 在打开工作镜像前获得最终 OS 锁（POSIX 文件锁，Windows LockFileEx），持有到退出；主控崩溃而 QEMU 仍在运行不能绕过它。

默认映射和输入来源位掩码由 core 管理；短按的每次转换串行提交 `qom-set /machine buttons`，不合并掉按下/松开。设备模型不认识配置或 UI。未来运行时改键应先释放旧来源，复用相同输入服务；重启 ROM 应复用停止/启动流程，不能把 `system_reset` 叫作游戏重开。

主要可维护入口：`src/core/session-controller.ts`、`src/main/index.ts`、`src/display/utility.ts`、`src/renderer/components/GameScreen.tsx`。新增 UI 功能必须同时定义真实控件 ID、自动化路径和日志事件。
