# 真实 UI 自动化

普通启动不监听自动化端口。开发与目录包都可用 `--automation` 显式启用。HTTP 仅绑定127.0.0.1随机端口，`POST /rpc` 接收 JSON-RPC2.0，最大请求64 KiB。UserData/automation.json 记录本次 instanceId、PID、URL、随机 token（文件0600）；退出清理。不得把 token 放进日志。

```sh
cd desktop
npm run build
node dist-cli/cli.js launch ../profiles/zelda.gnw.json --automation
# 在另一个终端连接已有实例：
node dist-cli/ui-cli.js ../UserData/automation.json automation.capabilities
node dist-cli/ui-cli.js ../UserData/automation.json ui.inspect
node dist-cli/ui-cli.js ../UserData/automation.json ui.menu '{"id":"file.make"}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.fill '{"id":"rom.internalFlash","value":"/absolute/bank1.bin"}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.fill '{"id":"rom.externalFlash","value":"/absolute/flash.bin"}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.click '{"id":"rom.saveAndLoad"}'
```

目录包：`gnw-emu.app/Contents/MacOS/gnw-emu --automation --user-data-dir=/absolute/data`。使用桌面构建中的同一 ui-cli.js 连接其 data/automation.json。CLI stdout 严格 JSON，日志/错误走 stderr；错误退出码非零。不重启已有实例、不自动重试有副作用请求。

ui.menu/click/fill/select/key/pointer 返回 operationId。用 `automation.getOperation {"operationId":"..."}` 查询 pending/succeeded/failed 和结果/错误。动作串行、最多保留200条；客户端超时应查询原 operationId，不能重复提交保存/加载。日志查询是另一个最多2000条的有界历史。

| 方法                             | 参数与读取                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| ui.inspect                       | 实际语言、DOM 控件、可见/禁用/错误/单选状态、表单值、原生菜单、窗口、Canvas最后收到/呈现帧        |
| ui.menu                          | id=file.open / file.make / view.chassis / app.quit / edit.* / window.*；执行 Menu handler 或对应原生 role 命令；checkbox 同步 checked 状态 |
| ui.click                         | id=真实 data-ui 控件；发送 Electron 鼠标事件                                            |
| ui.fill                          | id/value；真实点击、选择文本、insertText触发输入                                        |
| ui.select                        | id/value；真实 select DOM 的 input/change事件                                           |
| ui.key                           | key 为 Electron keyCode，如 Left、X；down=true/false                                    |
| ui.pointer                       | phase=down/up；id=真实控件；up 也支持 x/y 内容区域坐标，模拟在控件外释放；发送 Electron 鼠标事件 |
| ui.waitFor                       | condition=app.status/ui.dialogOpen/ui.lastPresented；value，timeoutMs≤60000，可选waitId |
| automation.cancelWait            | waitId；只取消等待，不能取消保存/加载                                                   |
| ui.screenshot                    | path=绝对.png路径；捕获实际 Electron 页面                                               |
| app.getState                     | 业务状态、错误及runtimeSessionId                                                        |
| app.getDiagnostics               | 帧/队列/丢弃、输入掩码、进程及内存；非普通用户界面                                      |
| logging.getConfig/configure/tail | 见 logging.md                                                                           |

动作可附 runtimeSessionId；不匹配时报 stale。失效窗口、不可见/禁用、模态阻挡均明确报错。原生菜单测试的边界是自定义 Menu click handler / 对应原生 role 命令，不能替代逐平台真实菜单弹出/键盘导航检查。

控件：app.open/app.make、rom.dialog、rom.model（radiogroup）、rom.model.zelda/mario（radio）、rom.internalFlash/externalFlash/bank2Flash/sdCard/sdWiring、rom.browse.<字段>、rom.save/saveAndLoad/cancel、game.canvas。游戏按键经过真实 keyboard event 与默认映射；自动化不直接改 core 按钮状态。

机身控件：chassis、chassis.button.left/up/right/down/a/b/game/time/pause，以及 Zelda 的 chassis.button.start/select。`ui.inspect` 的按钮 `pressed` 是真实 aria-pressed；菜单返回 type/checked；机身返回 chassis.visible/model/input。`app.getDiagnostics.input` 返回 desiredMask/appliedMask、resetGeneration 与 runtimeSessionId；`buttons` 是 desiredMask 别名。resetGeneration 区分显式清理与普通输入快照。确认硬件提交时等待 appliedMask，不将期望状态视作 QMP 成功。

长按例子（每个动作后先查询对应 operationId 完成）：

```sh
node dist-cli/ui-cli.js ../UserData/automation.json ui.pointer '{"id":"chassis.button.a","phase":"down"}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.key '{"key":"Left","down":true}'
node dist-cli/ui-cli.js ../UserData/automation.json app.getDiagnostics
node dist-cli/ui-cli.js ../UserData/automation.json ui.pointer '{"phase":"up","x":2,"y":2}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.key '{"key":"Left","down":false}'
node dist-cli/ui-cli.js ../UserData/automation.json ui.menu '{"id":"view.chassis"}'
```

鼠标只拥有一个指针来源；需要双指触摸时可用 Chromium CDP 的 Input.dispatchTouchEvent，应用按每个 pointerId 聚合。失焦、模态、隐藏或切换运行会清理机身来源。机身模式 Tab 导航控件、Space/Enter 操作聚焦按钮、Q=SELECT；纯画面保留 Tab=SELECT。

等待由业务/模态事件驱动，DOM/Canvas还提供200ms条件复核；不会把某个固定 sleep当作业务完成。截图返回图片尺寸，最后呈现序号仅说明绘制完成，不代表输入已被固件响应。

测试可额外启用 `--test-dialogs`（要求同时 --automation）。`automation.queueDialogResponse {"kind":"save","path":null}` 模拟取消，或 path 指定一次下一系统对话框结果。open 同理。队列最多20项；消费后仍走相同文件校验/保存逻辑。正常模式不会接受此命令。真实系统对话框仍须人工平台验证。

错误码：-32600请求、-32601方法、-32602参数、-32000业务失败、-32001忙、-32002超时、-32003受阻/禁用、-32004对象不存在、-32005陈旧会话、-32006等待取消。无正确 token 返回 HTTP401。

测试：`npm run test:e2e` 包含独立 Playwright UI 测试与 RPC 完整制作/加载场景；失败保留trace。截图、inspect/state/log材料写本地 out/ui-validation；不提交用户镜像。后续 MCP 可调用这一契约，不另建应用状态。

机型用 ui.click 选择 rom.model.zelda/mario，ui.inspect 的 checked 返回真实选中状态；ui.fill 仅接受文本输入框。app.quit/window.close 会结束应用，退出后无法查询 operationId，应等待进程结束/endpoint 清理并读取存档。阶段和业务错误分别有稳定 stage/errorCode/errorParams，不用翻译文本作测试断言。
