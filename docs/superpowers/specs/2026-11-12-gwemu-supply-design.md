# gwemu 原生电池存在与供电门禁

本批落实迁移阶段一的电池存在/断开和无电源停机，沿用已批准的整体路线。暂不增加桌面控件、修改 profile/session 格式或切换默认内核。

## 外部契约

- 仍由 startup-only `power-model=on` 启用；缺省关闭时保持上游运行与板级输入行为。
- 新增可写 QOM `/machine` `battery-present` 布尔属性，默认 true。独立于 `battery` 百分比；电量 0% 不代表拔掉电池，也不在本批引入耗尽截止电压。
- 新增只读 `/machine` `powered` 布尔属性。模型启用时为 `battery-present || usb-power`；模型关闭时为 true。
- 电池连接、USB 未接：运行、按既有虚拟时间速率耗电。
- 电池连接、USB 已接：运行、按既有速率充电。
- 电池拔出、USB 已接：运行；电池 ADC 输入为 0，PGOOD 仍有效，CHG 不有效，保存的电量不变化。
- 电池拔出、USB 未接：停止 CPU，不允许 QMP/HMP continue、GDB continue/step 或唤醒恢复执行。QMP 和调试端点保持可访问，用于读回状态和重新供电。

## 状态转换

有电到无电的转换必须先同步停止 VM，再清除 SRAM/备份域并复位 CPU/外设；保留内部/外部 Flash、SD、选项字节和 UID。取消旧启动交接、POWER 定时器和待处理 warm-reset fault 状态，不在无电时安排 POWER 按键。供电转换必须在 vCPU 停止后同步执行 `qemu_system_reset`，使属性写入返回前复位完成；不得仅投递异步 reset request 后放行 continue。标准 reset 同时清除旧 suspended 意图。

无电到有电：通过既有冷启动路径恢复启动 seed、复位并安排 POWER 脉冲，但保持 VM 暂停。调用者显式 continue 后才开始运行。恢复供电不得悄悄撤销用户或管理工具的暂停操作。

启动时就无电：初始 reset/loader 可以完成，但不允许 guest execution；TAMP 备份域清零，RDP startup handoff 不执行。恢复供电后走相同冷启动路径。

有电组合之间切换不冷复位，例如先接 USB 再拔电池应保留运行现场。断开电池期间改变 `battery` 可以修改保存的电量，但不会增加供电来源；重新连接后使用这个电量。

## 实现边界

不能只用 QMP `stop` 或 UI 暂停，因为其它入口可恢复执行。推荐为 MachineClass 添加可选 `can_run` 检查，缺省允许；在公共 `vm_prepare_start` 运行前检查，并在 QMP/GDB 执行命令层返回明确错误。GDB detach 的 OK 不得伴随第二个 E22；中央门禁静默拒绝恢复，只有执行报文发送错误，读寄存器和 detach/reconnect 保持可用。gnw-h7b0 类安装回调，但只有启用的模型或其供电转换期间会拒绝执行。停止时由 QEMU 标准暂停机制同步 vCPU，不依赖单次修改 ARM halted 位。

SoC 对供电是否存在保留布尔状态；无电 reset exit 不启动 handoff。显式 `gnw-cold-cycle` 无电时拒绝，不能作为另一个供电来源。设备 supply 状态由机器电源模块控制；完整 VMState/桌面即时存档仍不受支持。

这是离散供电来源模型：未模拟 BQ24072 电气过渡、CE/电流限制、真实锂电池化学、RTC/VBAT 保留、实机保护转换或突然断电中的 SD 写入一致性。QTest/GDB 的直接内存修改仍为调试能力，不受物理电压约束；门禁约束的是 guest execution。

## 验收

1. 用旧确切产物证明缺少 battery-present；先写失败测试，再实现。
2. 原生 QTest 覆盖四种来源组合、默认兼容、0% 与缺席区别、暂停时转换、电量冻结、ADC/GPIO、只读属性和 startup validation。
3. TCG 循环固件持续修改 SRAM 计数器：断开最后供电来源后计数器停且易失状态清零；QMP/HMP/GDB continue/step/reset/wakeup 不能重启；供电恢复后仍暂停，显式 continue 才重新计数。
4. 验证首次无电启动、POWER/startup timer 取消、重复断开/连接、Flash/UID 保留；退出后重开副本证明非易失内容持久。
5. 本地 Mario/Zelda OFW、Flash-only/SD Retro-Go 使用临时副本，运行后断开、拒绝继续、恢复且保持暂停，再通过冷启动/首次 TIME 输入重新渲染及 bank2 交接。全部源 SHA256 不变。
6. 干净构建、原生全部相关回归、桌面显式产物覆盖回归、独立审查后发布原生分支；主仓库只提交本地迁移分支。

补充验收：背靠背 restore/continue 不得执行复位前状态；无电 GDB detach 只有一个 OK，重连可用；`-M none` 无回调时仍可正常 continue。gnw-h7b0 当前未暴露真实 VM SUSPENDED 入口，采用标准同步 reset 的 vm_set_suspended(false) 语义，供电恢复不保留此前 suspend 意图。
