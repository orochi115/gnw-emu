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
