# 迁移审查意见处置

用户2026-11-13最新指令覆盖旧计划及技能的审查循环：只有同时具备具体触发、代码证据、实际严重后果、违反既定需求的 Critical/Important 可以阻塞；其余只记最终报告，不修改、不加测试、不阻塞。修后仅复核原问题与直接回归，复用有效证据，不新设完成门槛。重大范围变化交用户决策，原实机/实体手柄豁免及授权保持。

| 既有意见 | 实证与处置 | 当前是否阻塞 |
| --- | --- | --- |
| manager 调试后缓存过期 | 实际 dump→GDB 改PC→erase停滞，修后固件重载两次、1MiB FF读回正确，同租约；既有规范/质量独立闭合 | 否，修复已有有效证据 |
| GDB spawn 信号窗口泄漏 | 实际CLI130但ARM GDB child仍存活；修后SIGINT/TERM child在stdin EOF前回收，130/143正确 | 否，修复已有有效证据 |
| 旧 Task4 reset/mark/heartbeat 竞态 | 原实际越过授权/旧心跳误伤新租约已修；Task4五文件冻结未变 | 否，不重开已完成任务 |
| Q1 continue ACK 后过期返回 | 真实ACK后跨期限仍正常返回，但最终释放会拒绝；补后置检查已完成且根场景明确LEASE_EXPIRED。按新严重后果标准不新增审查循环 | 否，已有修复及原问题证据 |
| S1 failed release 重复退场及门禁提前解除 | 原有效失败释放NOT_OWNER、真实barrier未结束时deviceOperation已false，偏离独占/释放要求；修后原场景3例ACK+native paused，排队continue及stop/expiry/disconnect直接回归5例通过 | 否，原问题与直接回归已闭合 |
| Pyright unavailable/全项目历史lint | 无新功能严重后果实证，未声称通过，不为此安装或扩展工作 | 否，只记录限制 |
| 风格、抽象与假设性健壮性建议 | 不符合新阻塞标准。现有报告保留，后续同类意见只报告；不改源、不加测试 | 否，延期原因是用户明确限定原目标 |

验证复用：S1最终桌面104/zero skips、Python141focused及330all/1既有stock asset skip；恢复后5原问题直接回归与完整来源审计。实机、实体手柄是用户豁免，未记通过。所有软件原目标验收仍必需，Task6和产品退休不能因审查规则改变而省略。


## Electron 退出修复限定审查

本轮仅审查 listener 转发和相关测试。独立审查发现 P2：认证 inactivity timeout 可被 trickling peer 延长。实际 TCP 回归先失败，再改固定截止并确认14项 listener 单元通过。其余 inspected listener diff 未报告具体 Important/Critical。29项真实 manager server 集成与普通9次退出/重开、完整13桌面 manager 场景通过；后续完整LCD/包回归和本地合并记录见完成报告。按用户有限审查规则不恢复开放式 APPROVED 循环。
