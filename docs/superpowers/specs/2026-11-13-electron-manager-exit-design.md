# Electron 管理器监听器退出修复

用户已授权修复退出/启动故障、完成本地 master 合并和 macOS 重新打包；父仓库不推送。此修复沿用现有权限、Unix 端点、RPC/GDB 和 inode 所有权契约。

## 证据与选择

普通 Electron 39.8.10（无 debugger）也会在退出时 SIGTRAP，`base/files/scoped_file.cc` 报 Bad file descriptor。独立最小复现：BrowserWindow 或 Node IPC 监听 FD 分别正常，两者组合失败。Electron 40.10.6 同一最小复现首轮也失败，故不升级依赖。退出重入、日志线程、显示子进程 stdio、IPC keepOpen、先接收 FD 再创建窗口均未解决，诊断改动已回退。

选择不传递文件句柄的监听器转发。朴素直接 Unix listen 会在 Server.close 中无条件 unlink 原绑定路径，破坏外来替换保护；升级方案已被本地证据否定。

## 设计

父进程建立仅 127.0.0.1 的临时 TCP listener；附属 Node 进程绑定原私有 `.b-*/s` Unix socket，通过普通 IPC 接收 TCP 端口与每监听器随机 256-bit 凭据，回报 inode/uid，不传递 FD。父验证身份/0600 后通过既有独占 hardlink 发布端点，并按原 inode 检查清理 source/stage。子进程持有原 listener 至关闭，不调用会 unlink 路径的 Server.close。

每条 Unix 连接通过内部 TCP 连接双向 pipe。父在固定大小凭据、截止时间和待认证连接数量限制下认证，认证前不交付 RPC/GDB，认证后保留同一数据块的剩余字节。管道提供背压和 EOF；对端错误/关闭清理成对连接。凭据不在 argv/日志/descriptor 中。

返回的 Server 保持现有调用契约，close 关闭所有桥接/待认证连接、终止并等待附属进程回收。父 IPC 断开或 SIGTERM 时子进程直接退出；启动失败/取消/超时保留 inode/foreign 文件保护并回收资源。意外子进程退出关闭父 listener/连接。没有独立常驻 daemon。

## 验证与收尾

保留既有真实 Unix listener 的替换/冲突/取消/截止测试；更新“发布前回收 bootstrap”为“关闭时回收附属进程”，新增未认证 TCP 拒绝、数据完整/EOF、运行中附属进程死亡测试。已记录真实应用退出红例；增加普通无 debugger 启动/退出回归。GUI 串行运行，失败即停，使用临时 UserData 和 Cocoa ignore-state 标志，真实数据保留。

实际 Mario/Zelda 反复启动/退出、manager RPC/GDB、LCD 尺寸/像素/设置重开及目录包通过后更新完成报告和本地 master。复用有效 native 证据，不改 native 或真实镜像。按用户有限审查规则执行，不新增开放式审查循环。
