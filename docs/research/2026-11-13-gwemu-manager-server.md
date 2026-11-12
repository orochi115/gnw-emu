# 当前会话管理服务与 GDB 代理

状态：Task 3 已通过独立规范和质量审查。总体迁移目标仍在推进，Python client、CLI 和完整工作流待后续验收。

依据：`../superpowers/specs/2026-11-13-gwemu-session-manager-design.md` 和对应实施计划 Task 3。此前 controller 的独占、状态恢复及输入安全已在父本地提交 `ea7737b`。

## 服务边界

Electron 持有原生进程和唯一 QMP。Unix RPC 发布当前运行实例，授予绑定 RPC 连接、runtime UUID 和固定期限的 lease。GDB 客户端通过 lease 自有 Unix 代理连接原生调试端点，代理限制同时一个客户端。客户端通过心跳维持空闲期限，绝对截止不随心跳延长。正常释放在代理退休后按已知执行意图恢复应用；异常退出和到期保守暂停并标记不确定。

服务在 gwemu 桌面入口建立，未打开 ROM 时可列出空会话且不启动 native；关闭桌面先撤销服务，再停止 controller。Windows 当前会话服务明确不支持 Unix 端点，保留其他入口的既有平台边界。

## 原生断连证据

固定原生 GDB 实际探针发现：旧连接发送部分写入包后退出，新连接第一次请求可能得到 NACK。socket 关闭本身不能证明原生 RSP parser 已复位。服务使用有界、校验校验和的只读 `qSupported` 请求确认原生已接纳新连接，在 controller 恢复前完成原生通道退休；之后仍由 controller 执行固定的 QMP 停止、状态确认与必要复位。半包重连和大量排队写入的真实回归属于必需验收，不能用本地 `destroy()` 替代。

## 构建来源与保护范围

本批不修改 gwemu 或 manager 子模块。原生固定公开 revision 为 `a38484468d947ce6447fcc7dec47ebeef041f853`，测试和 gwemu 开发入口使用 `build/gwemu-session-manager-release/qemu-system-arm`，SHA256 为 `a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e`。该产物提供异常收尾所需的 host input 释放接口；历史 `gwemu-manager-ram` 构建继续保留。

真实测试仅使用隔离目录和合成镜像、owned child。十个源镜像的哈希、原 legacy PID16603、旁 manager、产品 UserData、旧 session/slots 和用户 `.superpowers/` 均受保护。父仓库仅本地提交；产品默认内核仍为 legacy，本批不切换默认或归档旧仓库。实机和实体手柄由用户豁免本次阻塞条件，不能记录为通过。

## 验收记录

Root 在第一版实现冻结后独立检查：12 个测试文件共 120 项通过，零跳过（服务 20 项、相关实际集成 59 项、相关单元 41 项），40.59 秒。类型检查、构建和差异检查退出码均为 0；冻结的 12 个修改文件及 3 个依赖文件哈希全部一致；十个源镜像哈希和原生程序哈希复核一致。日志为 `out/gwemu-completion/server-root-final-tests.log` 和 `server-root-build.log`。这些结果不代表后续 socket 修复已完成验收，修复后需新的冻结和验证。

Root 独立原生 probe 曾确认一个释放期限缺陷：释放进入恢复前的等待后，跨过 idle 或 absolute 截止，应用仍错误恢复 running。原因是进入 closing 时取消期限计时器。两个受控时钟、实际 native 的用例均先失败，证据保留在 `out/gwemu-completion/root-release-clock-probe.ts`。修复保持成功释放期间的期限计时器，到期会加强已有收尾为 abort；上述最终重跑包含正式回归，确认到期后为 unknown、无后续 cont。

有效独立规范审查 `server-spec-review-v2.txt` 实际运行服务 20 项、类型检查均通过，并发现自有 socket 清理边界未满足：Node/libuv 关闭 listener 会自动 unlink 绑定路径，即使该路径已换成其他 inode 的文件。实际 RPC probe 证明 foreign 文件被删除；RPC 和 lease proxy 共用的关闭实现均需修复。现有 Endpoint 的 inode 检查发生在 listener 已关闭之后，不能提供所承诺的保护。修复需要正式真实 replacement 回归，不能以泄漏 listener 代替清理。

代理消息传输曾将任务变成不可读 token，旧口头批准因缺少报告不采用；有效审查通过共享文件取得完整范围并落盘了实际证据。后续仍须先完成规范复审，再进行质量审查。

修复采用短命 IPC helper 绑定私有 Unix socket，再向父进程交接监听 FD；父 listener 没有 libuv 绑定路径，公开端点通过独占硬链接发布，并按 inode 清理。helper 用进程退出结束，避免私有路径发生同类自动 unlink。正式真实测试覆盖 RPC/proxy 的 foreign file 和 peer socket 替换，以及 helper 超时、取消、退出与私有端点替换。未知来源的 inode 保守保留。

Root 在修复后的 17 文件冻结上独立运行 13 个测试文件，共 134 项通过、零跳过（83 项实际集成和 51 项单元），40.99 秒；类型检查、构建和差异检查退出码为 0。正式源码重新 bundle 后在 Electron Run-as-Node 下两种 replacement 案例通过并回收 helper，日志为 `server-root-socket-fix-tests.log`、`server-root-socket-fix-build.log` 和 `server-root-electron.json`。有效规范复审 `server-spec-review-v3.txt` 独立运行 34 项、零跳过，并核对类型、17 SHA 与两种 Electron 案例后 APPROVED。

独立质量审查 `server-quality-review-v2.txt` APPROVED，无 Critical/Important 问题；独立 34 项零跳过、类型检查、Electron 两种 replacement 案例与前后 17 文件哈希复核均通过。额外私有 bootstrap 早连接探针未复现未跟踪连接泄漏，记录 `server-quality-v2-early-client.json`。最终十源/native 哈希与原 PID16603 保护复核一致。父仓库只本地提交本批改动。Python client、CLI 完整命令和真实 Electron 工作流分别属于 Task 4–6，不能以本批证据宣布整条迁移完成。
