# 当前会话 CLI 与外部 GDB 集成

Task5 已完成，manager 公开 `gnw-emu` 分支为 `9ef9cead5bd684cf47c39ccbd157a29ba01172b7`；Root 已核对远端完整 SHA 与本地一致，工作区 clean。父只本地提交。Task6 完整 Electron/manager 工作流，以及唯一内核产品迁移和历史依赖退役仍待完成；当前产品默认仍为 legacy。

## 实现

manager 默认延迟发现桌面 gwemu 会话，`sessions` 不取得租约，多会话需显式 `--session UUID`，无会话不会转向物理探针。显式 openocd/pyocd/gdb 保留 standalone 行为。离线 verify、HTTP fetch、坏或用户拒绝的 restore 不发现或连接设备。

多命令 `--` 和 shell 共用一条固定期限租约，吞掉的 shell 错误仍记录失败。内存/寄存器写、reset/resume 和 manager 上传在真正 RSP 动作前同步 mark，失败阻止动作。机器供电、暂停、重置和按键仅走受限 RPC；USB 开启且电池移除时仍供电。

外部 GDB 先接管租约 Unix proxy，manager 关闭自身 RSP，不公布 native 端点或自动 TCP fallback。调试后 GnW 全部固件/容量/上下文缓存失效，后续命令同租约重新上传；创建、信号转发与回收处于同一清理范围，恢复原处理器并保留130/143退出码。continue 收到真实 ACK 后再核固定租约期限，过期立即报错。

Mario/Zelda unlock 和 reprotect 使用同租约 cold-start 冷生效 RDP，真实读取0x55/0xAA及Flash debug权限验证；完整encrypted payload须真实蓝屏和SRAM副本SHA匹配。native 已自动POWER，CLI不重复发POWER。原物理交互算法、C固件及native未因CLI改动而变化。

桌面失败释放由服务协调取消与controller退场，管理门禁保持至proxy、排队RSP和native单客户端通道退休；最后QMP确认停止再回复原runtime descriptor。直接controller owner仍自动取消。失败/过期会话保持unknown，不恢复未知PC；旧清理不会接管新runtime。

## 验证和来源

- manager 最终有效证据：141 focused/zero skips；330 all/1既有stock patch asset skip，Black120及targeted Ruff py39、AST3.9。
- 桌面最终有效证据：104相关测试/zero skips、typecheck。恢复后仅复跑原S1与直接回归5例通过；其余24因命令过滤未执行，并非新增required skip。
- 真实public CLI证据包括双服务UUID选择、离线零发现、原始bank/extras捕获先于任何变更、同租约多命令和interactive shell、正常GDB读写/单步/断点、第二客户端拒绝、固定过期、SIGINT/TERM及spawn窗口回收、调试后两次firmware上传与1MiB FF读回。
- 两机型完整cold lock/unlock、三执行初态均有实际native证据。S1实际native原调度边界Root三例均收到有效失败释放ACK，QMP为paused/running=false；新增排队continue和释放中途stop/expiry/disconnect五例真实回归通过。
- `cli-source-v2.json`十一manager文件与Task4五文件/fixture保持一致，`failed-release-source.json`冻结三TS/test文件；Root完整来源审计确认十原镜像、固件ELF/package/unlock、native clean来源、旁manager和原legacy16603保持。

native仍是公开clean `a38484468d947ce6447fcc7dec47ebeef041f853`，固定binarySHA `a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e`。RAM固件未重编译；既有unlock.s在独立目录以固定GCC10组装的来源/hash保持。实机与实体手柄为用户豁免，不记通过；Pyright不可用和全项目历史lint未声称通过。

## 审查规则与剩余工作

用户最新要求覆盖旧全量开放审查循环：只在有具体触发、代码证据、实际严重后果且违反既定需求时允许Critical/Important阻塞；其余仅最终报告，不改、不测、不阻塞。原缓存停滞、child泄漏、租约竞态与S1均已按有效证据闭合；不重开旧任务。处置详见 `2026-11-13-gwemu-review-disposition.md`。

Task6继续固定的真实Electron+manager完整工作流，其后仍需旧数据兼容、唯一gwemu产品入口、构建/打包和历史依赖退役，不因规则改变省略原软件验收。
