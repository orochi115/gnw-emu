# 日志

使用 Pino，pino-pretty 格式化终端，pino-roll 在线程中滚动文件。默认 info、JSONL stderr；`--debug` 开 debug，`--log-pretty` 仅改变终端形式。stdout 留给 CLI JSON。文件为 UserData/logs/desktop.<日期>.<序号>.jsonl，10 MiB/每日轮转，保留5个历史文件加当前文件；不扫描日志文件回答UI查询。

公共字段：time（宿主 Unix毫秒）、level（Pino数值）、appInstanceId、source、module、event，相关操作/运行另含 operationId、runtimeSessionId/requestId。序号 uint64 用十进制字符串。error 包含类型、message、stack及cause；token/authorization及一层嵌套同名字段过滤。

主要事件：app.ready、operation.failure、session.state/failure、QEMU output，显示握手/故障/统计。QEMU stderr 保留原文及source=qemu，级别默认info，不把stderr本身当作error。高频输入/QMP诊断只在debug/trace记录，显示统计最多每秒，不打印逐帧像素。

机身：view 模块 `chassis.visibility`（info）记录持久化后的开关；input 模块 `button`（debug）记录 bit/down/source，`key` 记录键盘来源，`mask` 记录 desiredMask/appliedMask；`submit.failure`（error）保留失败的 mask 和会话 ID。按键反馈不要求开启 debug 日志，状态通过 IPC 推送。

```sh
node desktop/dist-cli/ui-cli.js UserData/automation.json logging.getConfig
node desktop/dist-cli/ui-cli.js UserData/automation.json logging.configure '{"level":"debug","modules":{"session":"debug","renderer":"warn"}}'
node desktop/dist-cli/ui-cli.js UserData/automation.json logging.tail '{"limit":50,"module":"session","after":0}'
```

动态配置更新已存在的模块 logger。近期缓冲最多2000条，查询最多200条，返回cursor/overwritten，after用于读取增量；历史已覆盖可由overwritten识别。文件仍保留更长历史。renderer桥单条≤8 KiB、最多40条/秒；utility不发送像素日志。滚动transport失败回退stderr，不能使日志故障中断游戏。

不在日志里写固件/SD内容。路径作为诊断信息保留，因此日志文件适合本地排查；截图/日志不会自动上传。新模块应注入logger、定义明确event及单位，并同步更新本页。

窗口模式：view 模块 `window.mode`（info）记录桌面时钟进入/返回与运行 ID；`window.state`（debug）记录焦点/最大化/模式变化。renderer 的 `window.action.failure`（error）记录窗口控制失败，不记录拖动位置或逐帧画面。

view 的 `window.scale`（info）记录像素倍率选择（包括 1×）；`window.state`（debug）新增 pixelPerfect/scaleFactor，手动离开 1:1 或显示密度变化时发布。重复不变状态被去重，拖动不逐坐标记录。

倍率与持久化：view 的 `window.scale`（info）记录预设选择，携带 pixelScale/renderScale、normalScale/clockScale、scaleFactor 与当前模式；`window.mode` 的 reason=preference 标识启动/加载后的自动恢复。`window.state`（debug）也包含 preferredClockMode/transitioning，避免将暂时返回误判为用户关闭。`view.settings.saved`（debug）记录合并后的倍率/位置/模式设置写入，`view.settings.failure`（error）记录原始错误；拖动/缩放按 250ms 合并写入，非逐指针事件。正常退出等待 flush，磁盘失败不暂停或重启游戏。

app 的 `recent.record` / `recent.clear`（info）记录成功保存历史和清空；`operation.failure` 包含历史写入或加载失败原因。历史写入失败不改变已运行的 QEMU。

view 的 `window.dock`（info）记录角落与实际窗口边界；audio 的 `audio.mute`（info）记录已提交静音状态和 runtimeSessionId。QMP 日志记录 audio-muted 的请求/响应耗时；失败沿用 operation.failure，写设置失败会回滚 QMP 静音。

若日志出现 `coreaudio: Could not resume playback ... -536870186`，对应 macOS I/O Timeout（0xe00002d6），应先检查其他应用是否同样无声及当前系统输出设备。USB/耳机重新连接或切换输出设备可用于判断设备状态；静音菜单不会修复系统输出设备故障。应用不自动重启系统音频服务。
