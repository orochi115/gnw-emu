# Python 会话客户端与 Unix GDB

状态：Task 4 v4 规范与质量复审均已批准，Python 会话客户端及 Unix GDB 已完成。CLI 默认路由、完整 manager 命令和外部调试交接属于后续 Task 5–6。

依据当前会话管理设计及实施计划 Task 4。桌面服务已在父仓库本地提交 `f066e66`，采用固定原生 clean revision `a38484468d947ce6447fcc7dec47ebeef041f853`、程序 SHA256 `a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e`。本批仅修改 manager Python host 代码和测试，不修改固件或原生模型；审查和完整集成完成之前不发布 manager。

## 接入约束

客户端在同一 RPC 连接内持有 lease，独立 reader 按请求 id 分发回复，独立 heartbeat 保持空闲期限。等待主命令不能持有心跳所需的锁；心跳不延长绝对截止，失败必须被主操作观察。退出通过显式 completion 收尾，异常不能冒充成功。

Unix GDB 默认不恢复执行，保持管理暂停基线；显式 TCP 保留既有默认行为。每次底层接收均按命令总截止设置剩余 timeout，不能通过不断到来的慢碎片延长命令。真实 GDB 读写之前的同步 mark API 供后续 CLI 接入使用；己方重置后清除已确认标记缓存，保留累计 completion flags，确保后续变更重新经过服务门禁。

## 初步独立互通证据

Root 的 `out/gwemu-completion/client-real-service.ts` 从正式桌面模块 bundle，使用隔离目录、合成 bank1/Flash、真实 TCG 和正式 RPC/proxy，不访问实际 UserData。监督器有 120 秒 watchdog，退出检查自有 native 回收、合成源未改及端点清理。

`client-real-gdb-probe.py` 与 `client-real-session-probe.py` 首轮均退出 0：运行、暂停、断电三种初态读取实际 PC `0x08000008` 和 Flash 前缀，正常只读 release 恢复各自执行状态；完整客户端实际发现、选择、hello 和 lease 成功。两种有供电初态还验证同步 mark 后 SRAM 写入读回、未知执行现场拒绝 press，以及己方 warm-reset 后再次 mark 使 resume 被拒绝。reader/heartbeat 与自有 native 均退出。

最终 5 文件冻结后，Root 再次独立运行全套 manager 测试，276 项通过、1 项既有 stock asset 跳过，13.45 秒；上述正式服务三种初态和两种 mark/reset 门禁互通复验退出 0。五个源码 SHA256 与共同 fixture 字节一致，记录 `client-root-all-tests.log`、`client-root-real-session.json` 和 `client-source.json`。这些证据不能替代独立规范及质量审查。日志与 JSON 保留在 `out/gwemu-completion/client-real-*`。manager 基线全套为 232 项通过、1 项既有 stock asset 缺失跳过；新会话和 transport focused 测试要求零跳过。

## 保护与剩余工作

十个原始镜像、产品 UserData/session/slots、旁 manager、原 legacy PID16603、用户 `.superpowers/` 和历史 build 保持保护。产品默认仍 legacy。物理硬件和实体手柄已由用户豁免本次阻塞，记录为豁免而非通过。

实现者冻结验收另记录 87 项 focused 测试（40 会话、47 GDB）零跳过，包含完整 5 秒命令的真实慢碎片、半包超时、获取期限、释放/心跳与写锁取消回归。Black 120 列和 Python 3.9 语法检查通过；新文件 Ruff 按项目支持的 Python 3.9 验证通过，既有 GDB TRY301 告警保留。现有环境未安装 pyright，不记录类型检查通过。

Task 4 两级独立审查已完成。后续继续 CLI 多命令与 shell 共用 lease、离线备份路由、同步变更 hook、外部 GDB 和完整 Electron 工作流，再进入唯一内核产品迁移和历史依赖退役。整个迁移目标仍 active。

独立规范审查 `client-spec-review.txt` CHANGES REQUIRED：真实服务已完成 warm-reset、客户端 control 回复尚未消费时，并发 mark 沿用旧 acknowledged cache 而不发送新标记。实际 SRAM loop/PC 写入后 resume 错误获准运行。Root 独立重跑同复现，保留 `client-spec-reset-cache-probe.json` 与 `client-root-reset-cache-probe.json`，PC `0x20000200`。原有 87 项和全套 276 项均通过不能覆盖此竞态；修复需确定性窗口回归及真实原生复验。旧五文件 freeze 保留，新修复使用 v2 冻结。

I1 修复在发送 warm/cold 重置前同步进入计数窗口，在所有结束分支再次清除 epoch/cache；存在任一重置窗口时非空 mark 立即返回 BUSY，调用方不得写入。七项新增真实 socket 回归先复现再通过，覆盖窗口、失败、重叠、迟到标记和超时回收。修复后专项 94 项零跳过、全套 283 项通过且仅既有 1 跳过；Root 在 v2 五文件冻结后独立复验全套及实际 TCG warm/cold 两窗口通过，未知 PC 的 resume/press 均 TARGET_UNSAFE。证据 `client-source-v2.json`、`client-root-v2-all.log`、`client-root-v2-window.json`，独立复审仍待结论。

有效 v2 规范复审 `client-spec-review-v2.txt` CHANGES REQUIRED：真实 mark 已获确认但客户端返回被延迟，己方 reset 完成后，该旧 mark 仍返回成功，虽未写入 ack cache，调用方仍据此发送 SRAM/PC 写入并获准 resume。Root 独立 warm/cold 两例同复现，证据 `client-root-v2-late-mark-probe.json`，旧 v2 94/all283 绿不能覆盖当前授权失效。后续必须在 mark 返回授权前复核 epoch 和租约，保存已确认累计 flags 但拒绝过时授权。

v3 在保存远端已确认累计变化之后、返回写入授权之前，统一在租约锁内复核失效状态、绝对期限和 reset epoch，过时结果返回 BUSY 或租约错误，不再只阻止缓存更新。七项逆方向/失效回归 RED→GREEN；专项 100 项零跳过，全套 289 项通过且仅既有 1 跳过。Root 五文件冻结复验、共同 fixture 一致，以及 I1/I2 两组 warm/cold 实际 TCG 四例通过。Root 首轮全套曾触发未改动 SoftSPI 子进程 1 秒超时，9 项单独重跑及全套重跑均通过，保留首次失败日志且不改期限。最后全套为 289 passed/1 existing skip，13.93 秒，证据 `client-root-v3-validation.json`，规范/质量结论仍待后续。

有效规范 v3 APPROVED，独立 100/289 测试及 I1/I2 四 TCG 场景闭合。质量审查 `client-quality-review-v3.txt` CHANGES REQUIRED I3：正常 release 设置 stop 但正在进行的 heartbeat request 未被取消，join 1 秒后仍活；它后来超时先触发全局连接失效，误伤同一连接中的新租约。真实 Unix peer 与正式 TS/TCG 两种探针复现，Root peer 独立同复现。需要租约身份关联的请求取消与失败传播，保留 active 心跳及半包/未知变更的保守断连；旧报告/冻结和 RED 证据保留，新修复须规范、质量重审。

I3 v4 修复将 leased 请求绑定原租约取消事件，并在 admission、写锁、发送和回复消费处复核；退休与全局失效发布使用同一状态锁。完整只读帧可本地取消，半包和未确认变更保持保守断连。13 项新回归 RED→GREEN，最终专项 113 项零跳过、全套 302 项通过且仅既有 1 跳过。Root 冻结后独立全套 302/1（19.12 秒）及真实 peer/正式 TS+TCG 心跳交接、I1/I2 warm/cold 四例均通过；真实 native 中新租约在旧线程恢复前已获取，退休 heartbeat 实际发送帧为 0，新 owner 健康、正常 release 回暂停、native 回收。证据 `client-source-v4.json`、`client-root-v4-validation.json`，有效规范报告 `client-spec-review-v4.txt` APPROVED；质量 v4 尚在审查，不提前开始 Task5、提交或发布 manager。

最终独立质量报告 `client-quality-review-v4.txt` APPROVED：113 项专项、302 全套/1既有跳过，新增六个真实 Unix peer 退休场景及五个正式 TS/TCG 竞态场景全部通过。五文件 SHA 在审查前后完全一致，I1/I2/I3 均闭合。Task4 完成，本地检查点后推进 Task5；公开发布仍以完整集成审查为门槛，整个迁移尚未完成。
