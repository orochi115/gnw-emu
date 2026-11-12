# gwemu 管理控制器验收

本批实现当前会话接入计划 Task 2：桌面控制器独占管理、设备动作和结束恢复。RPC 服务、GDB proxy、Python 自动发现与完整固件工作流仍由后续任务实施。独立规范与质量复审均已批准，本批已关闭。

## 行为与边界

`beginManager` 在第一次等待前同步占有 owner 并关闭普通桌面操作入口，等待已接受的供电和存档操作，再捕获初始执行与供电状态、释放宿主按键并暂停。管理 owner 绑定 runtime UUID、绝对期限和取消信号；普通换 ROM、存档、静音、设备动作和输入不能越过管理门禁，关闭窗口始终可以停止会话。

`markManager` 在未知 GDB 上传、内存写入或执行改变之前同步撤销安全应用标记。debug 会话默认需要重置后才允许应用执行。每次非空 mark 推进修改序号，较早的 warm/cold reset 完成不能覆盖较新的标记。read 会话不能调用设备控制。已接受的 press/resume 从第一次等待前至操作结束，与非空 mark 同步互斥；冷启动确认应用执行期间同样互斥。重叠 mark 返回 `BUSY`，不改变标记、修改序号或安全状态。调用方必须等待 mark 成功后才发送对应 GDB 动作；reset 阶段仍允许 mark，并保留修改序号保护。

正常 `press` 在已知应用中临时执行，发送按下、等待、在运行时发送释放并留出有限观察窗口，然后暂停。异常清理只停止并调用固定的 `gnw-release-host-input`，不继续未知 PC。显式 pause/resume 意图在结束后保留；纯 raw 管理恢复初始执行状态而不 reset；已标记未知改变的成功结束先回到 bank1 应用，再按意图及当前供电恢复。失败、取消或超时保守标记未知，仅关闭并重开可恢复。

每次加载分配私有 Unix native GDB socket，不向公开会话描述符提供原生端点。启动后独立观察并认领 socket inode，不等待画面就绪；启动失败和关闭等待认领任务后仅清理匹配 inode，保留替换资源。Windows 普通桌面加载绕过 Unix 端点；本批未进行 Windows 运行时验收。

## 实际验证

主代理显式使用干净原生程序运行以下集成组：

```sh
cd desktop
GWEMU_DESKTOP_BINARY=/Users/sakura/GameWatch_Zelda/gnw-emu/build/gwemu-session-manager-release/qemu-system-arm npm run test -- tests/integration/manager-controller.test.ts tests/integration/gwemu-supply-controller.test.ts tests/integration/gwemu-savestate-controller.test.ts tests/integration/startup-cancellation.test.ts
```

结果：**59 项通过，零跳过，40.28 秒**，其中控制器 25 项。相关 backend/protocol/endpoints/session-lease 单元测试 **35 项通过，零跳过**；类型、格式和差异检查通过。集成测试使用独立合成镜像、隔离 UserData、真实 TCG、Unix RSP 与 qtest 观测，不触及产品历史数据。每个测试回收所观察的任务子进程并核对合成源字节。

真实验证包含运行和暂停初态的 guest 按下/释放采样计数、raw PC/RAM 保留、显式运行意图、实际 GDB SRAM/PC 改写后恢复、无供电门禁、取消和期限、停止竞态、错误后的关闭重开，以及启动崩溃/取消和替换 socket 保留。

独立规范初审额外复现两项阻塞，均补入确定性原生回归后修复：画面就绪前崩溃遗留尚未认领的 socket；reset 完成覆盖较新的 mark，使实际改写的 SRAM PC 获得运行许可。规范复审重新构建原始探针，确认清理后端点为空、较新修改保持暂停并返回 `TARGET_UNSAFE`；55 项独立集成测试亦通过，v2 规范 **APPROVED**。质量审查随后复现长按等待期间的新 mark 未阻止后续输入；增加四项真实原生回归后采用同步互斥修复，同时覆盖 resume/cold-start 确认窗口。v3 独立规范复审已批准，25 项控制器测试通过；质量复审已批准，独立 25 项原生与 35 项单元测试均通过、零跳过。

## 来源与后续义务

原生来源 `a38484468d947ce6447fcc7dec47ebeef041f853`，manifest `sourceDirty=false`，实际二进制 SHA256：

```text
a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e
```

本批不改原生或 manager 源码。十个原始镜像哈希、旁 manager 清洁状态和原 legacy PID16603 已核对。父仓库只本地提交，不推送；实机和实体手柄按用户要求豁免，未声称通过。

成功恢复依赖后续 Task 3 先撤销 proxy、确认 native GDB upstream 已断连并完成同步屏障，防止旧排队写晚到应用。控制器测试的直接 RSP 仅证明内部恢复行为，不替代 RPC/proxy、外部调试器交接或完整固件管理验收。旧默认内核、唯一产品入口及依赖退役仍待后续计划关闭。

审查与证据：`out/gwemu-completion/controller-implementation.txt`、`controller-source.json`、`controller-root-validation.json`、`controller-spec-review.txt`、`controller-spec-rereview.txt`、`controller-v3-spec-review.txt`、`controller-v3-quality-review.txt`；旧 v1/v2 证据保留。
