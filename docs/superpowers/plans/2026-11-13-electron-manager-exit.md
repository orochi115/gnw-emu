# Electron 管理器退出修复计划

**Goal:** 消除正常退出 SIGTRAP 和后续 macOS 重开提示。
**Architecture:** 附属进程持有私有 Unix listener，通过带随机凭据的 loopback TCP 转发，不传 FD；复用 inode publication/cleanup。
**Tech Stack:** Electron 39、Node net/child_process、Vitest、Playwright。

按用户既有修复/本地合并授权执行，不新增审批或开放式 review 循环。

- [x] 普通应用和最小组合复现失败，临时 Electron 40 验证仍失败。
- [x] 更新真实 listener 测试覆盖生命周期、认证和转发，确认新契约红例。
- [x] 实现 `desktop/src/core/manager-socket-listener.ts` 转发，不改外部接口。
- [x] listener/server 回归、typecheck/build。
- [x] 持久化无 debugger 启动退出回归，Mario/Zelda 复制 session 验证。
- [x] 串行 chassis 和 packaged 验证，更新完成报告实际身份/边界。
- [x] 本地提交、fast-forward master，保留历史/用户数据，不 push。


验收：14 listener 单元、29 native server 集成、3 ordinary exit（9 cycles）+13实际 manager 场景、7 LCD/标准浏览器输入、2 macOS directory package 分批通过，仍有效 native240/copied firmware14证据复用。原 mixed-input 合成捕获测试的不稳定保留报告，不计全套一次绿；等待帧/注入modifier诊断已回退，生产捕获释放保护不变。限定独立审查P2固定认证截止已按red/green修复。父仓库仅本地ff，分支/旧历史保留。
