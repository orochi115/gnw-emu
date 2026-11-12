# 当前会话管理所需的安全按键释放

Task1b实现、两级独立审查和干净产物回归已通过。原生提交`a38484468d947ce6447fcc7dec47ebeef041f853`已公开发布到`orochi115/gwemu:gnw-emu`，远程SHA与本地一致。当前会话controller/server和真实manager解锁/重新保护仍在后续任务；本批不代表整体迁移完成。

标准QMP输入在暂停时被拒绝，异常退出不能为了松键恢复未知PC。新增固定无参数HMP `gnw-release-host-input`，返回清除的宿主按键数量；桌面helper检查有界确认后清除宿主mask/pending，并阻止旧输入完成重新写入mask。它通过UI已有QMP连接调用，不开放任意HMP转发。

实际审查复现了自动冷启动POWER与宿主POWER重叠时的提前释放。修复用独立host/nonhost状态及有效OR边沿，涵盖宿主正常keyup、自动释放、旧自动输入及复位PA0短脉冲。GPIO VMState4保存非宿主虚拟状态，冷复位清理两种来源，读档清理宿主所有权。旧字段缺失时不继承目的地的旧标记。

干净来源：`build/gwemu-session-manager-release/gnw-build-manifest.json`；`sourceDirty=false`；产物SHA256 `a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e`。dirty审查构建和证据保留在`build/gwemu-session-manager`及`out/gwemu-completion/session-input/review-dirty`，未重新标记为干净构建。旧manager-ram/legacy产物没有覆盖。

| 验收 | 结果 |
| --- | --- |
| 实际TCG输入专项 | 13 passed，zero skips；暂停/断电时PC、SRAM、ITCM、三份Flash与runstate不变，全部12键及相同按键再次按下有效 |
| 来源重叠 | host-only及普通keyup均保留自动POWER；自动释放保留宿主POWER，原定时器仍完成正常释放；snapshot/reset与旧自动LEFT输入均覆盖 |
| 合成交接 | 安全ITCM签名与新SRAM、GDB寄存器sentinel证明宿主清理不重复触发已消费的自动POWER交接边沿，原自动释放重新允许下一次边沿 |
| 干净原生合并回归 | 116 passed，21.72秒，zero skips；包含上述13项、95项gamepad/power/supply/RTC/Flash-savestate和8项RDP/GDB回归 |
| 桌面集成 | 34 passed，39.11秒，zero skips；供电、存档与启动取消，明确指定新产物 |
| 桌面helper/协议 | 35 passed，zero skips；类型、格式与source7哈希复核通过，独立规范和质量审查均APPROVED |

专项证据索引`out/gwemu-completion/session-input-acceptance-index.json`记录13次干净native运行；各PID退出0并回收。十个原始镜像大小/SHA、旁manager干净身份、旧backup验收binary SHA不变，原legacy PID16603仍运行。父仓库只作本地提交。

完整环境脚本GNW_AUTO_INPUT/GNW_TIMELINE的全局回放位置和定时器没有迁入VMState，本批仅验证其输入来源在宿主清理时保留。桌面kernelEnvironment剥离全部GNW_/GWEMU_变量；支持的冷启动POWER及其SoC定时器另有真实读档恢复验收。旧干净构建的状态在原生版本/配置身份检查被拒绝；桌面另检查实际binary SHA，不承诺跨构建旧slot兼容或已运行验证旧GPIO版本的缺失字段分支。旧文件保留。

合成交接不等于真实manager unlock payload或实机验证。实机与实体手柄按用户要求豁免。已有preview默认仍选旧manager-ram；后续controller测试和接入必须选择本批新产物，不能假定旧产物支持安全释放；最终sole-kernel切换另有计划。
