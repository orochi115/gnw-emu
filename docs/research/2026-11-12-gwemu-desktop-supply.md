# gwemu 桌面供电接入验收

日期：2026-11-12。范围：迁移阶段一的隔离桌面供电、暂停恢复、冷启动与 session 适配。默认内核仍为 legacy；本批不实现完整即时存档、管理端发现、备份迁移或 GDB 接管。

## 交付行为

gwemu 开发入口固定使用 `build/gwemu-supply/qemu-system-arm`。普通窗口与时钟窗口的「设备」菜单支持电量增减、电池连接、USB 供电、暂停、继续、冷启动；新增动作可自定义热键，未增加默认绑定，既有 C USB 热键在无电源/暂停时仍可使用。

电池存在与百分比独立。拔出电池但 USB 供电时保持运行；失去最后供电来源后原生停机并清除 SRAM/TAMP。恢复来源保持暂停，显式继续才执行。冷启动明确执行复位并运行：先释放输入/停止，订阅 QMP RESET，发 HMP 请求，等待 host-ui RESET，再用 query-status 确认主循环完成，最后继续。

无电源时关闭、重新加载同一隔离 session 不执行 cont、不等待首帧。gwemu session 专用严格 schema 保存 batteryPresent；旧 gwemu 元数据缺省 batteryPresent=true，legacy session/exit JSON 不增字段。只有严格原生快照、子进程 exit0 与文件同步成功才保存；快照错误、队列超时、强制退出均报告保存不确定并仍关闭子进程。

设备操作绑定捕获的 runtime，串联执行；关闭/换 ROM 后禁止旧执行动作继续或发布新会话状态。已授权来源操作在旧 runtime 内完成再保存。设备操作期间阻止硬件输入，ControlRouter 重置/隔离 held 与 turbo，要求释放后重新按下。暂停/断电禁用机身按钮，断电/状态未知遮盖旧画面；读回失败进入 unknown 并禁用继续/冷启动。

## 产物与验证

原生源码保持 clean，revision `eabbd8cc1476722a6f8d8e981189a9aede99d917`；本批没有改动原生子模块。产物 SHA256：

```text
dc062a2679cc26a54f57737d5b8444dc270229c908330da32f9ece478b8ba4e8
```

preflight 在停止旧 ROM 前先检查能力。只读 powered 不出现在机器 help，因此另启 `-M none -S` 临时进程，通过 qom-list-properties 检查 powered/battery-present 均为 bool；不会打开源或 session 镜像。

新增测试按先失败再实现运行，日志保存在 `out/desktop-supply-{unit,controller,menu,automation}-red.log`。初次全量回归发现旧 legacy 已授权电量队列在停止时被跳过，修正为来源操作完成、执行操作禁止继续。

质量审查另用真实内核复现启动期间关闭竞态：初始供电读取返回后仍可能发送 cont。增加启动取消回归并先观察失败，再在启动异步边界加入取消、runtime 身份和 stopping 检查。独立复审重建复现脚本后确认没有 cont/input，关闭后显示、lease 与子进程均清理。

最终确切产物验证：

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 全部桌面单元/集成测试，显式 supply 产物 | 162 项／42 文件通过，无跳过 | out/gwemu-desktop-supply-tests-final.log |
| TypeScript 类型检查 | 通过 | out/gwemu-desktop-supply-typecheck-final.log |
| 桌面与 CLI 构建 | 通过（已有 Vite 大 chunk 提示） | out/gwemu-desktop-supply-build-final.log |
| Electron 供电／预览／SD／legacy 自动化／主窗口 | 5 项通过，无跳过 | out/gwemu-desktop-supply-e2e-final.log |
| 独立规范复审 | APPROVED | out/desktop-supply-spec-review.txt |
| 独立质量复审 | APPROVED，无 Critical/Important | out/desktop-supply-quality-review.txt |

7 项真实内核供电 controller 测试包含在全量测试中；审查另独立复验这些用例及 26 项相关单元测试。GUI 最终截图在窗口切回普通模式并确认实际绘制后采集，避免截取切换期间尚未重绘的黑画面；已目视核对 Zelda 画面。原生实现没有变化，本批未重复宣称此前原生 59 项／固件 8 项验收属于新测试。

收尾确认最早 controller RED 阶段因未实现 cold action、测试等待进入点超时而留下临时 QEMU；已按临时 session 路径确认并关闭。测试进入点现在采用有界 deadline，异常会进入 finally 释放阻塞及清理子进程；7 项 controller 重新验证。现有产品 QEMU 未终止。

## 隔离与边界

真实 controller 测试使用临时合成循环固件和测试专用 QTest 连接，覆盖暂停输入、冗余来源、易失标记清除、Flash 保留、断电重开、冷启动 RESET、快照错误、换 ROM/关闭队列、未知状态恢复、队列超时和启动取消。QTest 写入的标记用于验证控制与持久化，不代表物理 Flash 编程或中途 SD 写入一致性。

Electron 使用临时 --user-data-dir 和 Zelda ROM 副本，验证设备菜单、默认 C 热键、断电重开、显式继续、冷启动后新帧、机身禁用和时钟菜单。另回归 Mario/Zelda 预览切换、软件 SPI SD Retro-Go 及 legacy 自动化/主窗口。新增供电验收在 finally 校验源镜像；既有预览/SD 回归在成功完成时复核源哈希。未挂载或修改产品 UserData 与旧 session/state。截图保存于 `out/gwemu-desktop-supply/restored.png`。

Zelda 源 SHA256：内部 Flash `ab37ba03bc33682c091b4e7caffd7d3102b83e675377e06d6d3046b9bf483bb6`；外部 Flash `ab89fa56257e5158e5405bb3c5b85f1a6960e8358db66d6bb62e567b26672a0f`。

这批不改变先前原生电气模型边界：真实电压/化学、RTC/VBAT、保护转换、正在进行的 SD 写入断电一致性仍未验收。完整 gwemu 即时存档、RTC 用户流程、实时限速和阶段二/三仍待后续推进，不能据此退出旧内核。
