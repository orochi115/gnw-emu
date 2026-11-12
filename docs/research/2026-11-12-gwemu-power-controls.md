# gwemu 电量与 USB 控制实测

日期：2026-11-12。范围：阶段一的隔离桌面开发预览继续接入电量/USB，并验证部分已有冷启动行为。默认内核仍为旧 QEMU；完整阶段一与后续工具链迁移尚未完成。历史桌面桥证据见 [上一批报告](2026-11-12-gwemu-desktop-preview.md)，当前启动命令见 [迁移说明](../desktop/gwemu-migration.md)。

## 来源与产物

公开仓库 [orochi115/gwemu](https://github.com/orochi115/gwemu) 固定 `fed744e0dcd7a694443cabc1d478ff3deddfa34a`（父提交 `f744411`）。发布后已使用 `git ls-remote origin refs/heads/gnw-emu` 核对远程 SHA。

从干净提交全新构建到 `build/gwemu-power`，manifest revision 一致、`sourceDirty=false`、tracked diff 为空。产物 SHA-256：`a7b1021e25417d06e361bffb54bce60b7bda46a4ad17e6867af198b527f99355`；版本 `QEMU 11.0.2 (v0.0.29-3-gfed744e)`。宿主 Apple arm64、macOS 24.6.0、Apple clang17、Python3.15.2。构建日志 `out/gwemu-power-clean-build.log`；不承诺字节可复现或非 macOS 运行兼容。

桌面预览现在固定读取这一目录，旧构建目录保留供对照。原生 power-model 默认关闭，保持上游固定 ADC/PGOOD 行为；桌面显式开启，普通比较探针仍保留原生默认。

## 模型与桌面行为

板级模块接受 `power-model=on,battery=0..100,usb-power=on/off,battery-life-min=N,charge-time-min=N`。电量/USB 可通过 `/machine` QOM 修改，开关与周期只能初始化前配置。channel4 的 ADC1/2 输入使用当前 Retro-Go BQ24072 标尺 11000..13000，VREFINT 与其他 channel 沿用上游逻辑；timing/non-timing 转换均覆盖。PA2 PGOOD、PE7 CHG active-low，通过既有 SYSCFG/EXTI 路由传播。GPIO/ADC reset 保留外部输入，复用已有按 MODER 生效的 PC8 strap，不无条件更改 reset/analog/output 读回。

虚拟时间驱动放电/充电，0周期禁用相应变化，暂停不消耗。电量对外四舍五入为整数；ADC 使用内部连续值，实时读回可能因少量充放电差1个采样单位。运行时 setter 在修改前校验范围，非法 startup 电量在镜像初始化前拒绝。

桌面复用现有热键（默认 - / = 电量、C USB）。读改写按捕获的 runtime 串行，换 ROM/停止不会将操作转向新会话。停止阻止新操作，等待已接受的电源队列，然后暂停并读取严格校验的电量/USB；只有 exit0 且 fsync 成功才更新 session 元数据。读回失败仍执行 quit/必要时 kill 并等待退出，报告保存不确定，保留旧元数据。崩溃仍按不确定处理。即时存档继续禁用，隔离路径与原生锁沿用上一批。

这是现有产品标尺的板级输入近似，0% 不代表电池物理断开或供电域掉电；没有建模真实化学曲线、充电器 CE/电流限制或无电源时停止 CPU。Host 电量/计时器尚不纳入 migration/savestate，当前没有开放即时存档。

## 最终验证

| 检查 | 实际结果 |
| --- | --- |
| 原生容量/桌面/电源 | 26项通过：ADC1/2 两条路径、电量范围、PGOOD/CHG/EXTI、reset、PC8、虚拟充放电/0周期/大周期、暂停，以及之前帧/UID/锁/PCM回归 |
| 本地真实固件电源 | 4项通过，无跳过：Mario/Zelda OFW、Flash-only、SPI1 SD；独立镜像、实际画面、Retro-Go bank2 VTOR、ADC/GPIO变化、源前后SHA-256一致 |
| 完整桌面 Vitest | 39文件、141项通过，无跳过；包含真实gwemu电源持久化与错误清理及旧内核生命周期/状态回归 |
| typecheck/build | 通过 |
| gwemu真实Electron | 1项通过（8秒）：Zelda与Mario画面、输入/焦点释放/静音、状态菜单禁用、电量/USB热键、换ROM/重开持久化、退出无进程 |
| 旧默认内核Electron | automation-ui 1项通过 |
| 审查 | 原生规格/质量与桌面审查通过，最终差异审查记录保存在本地证据目录 |

真实控制器在 session 内部 Flash 写入标记，正常关闭重开后保留；并发两次电量降低和两次USB切换不会丢失更新。QTest读回 ADC 与充电器引脚符合80%/USB接入。模拟 qom-get 电量失败后，stop 报告 saveUncertain，PID已退出，session.json 字节不变，lease可重用并能重新加载；SIGKILL仍标记不确定。源镜像缓冲区保持不变。

新增停止顺序回归先在旧实现复现 stop 提前结束，然后验证修复等待读改写完成。Electron 验收通过实际键盘热键进入控制路由；电量100→80/USB接入，切换Mario时保存80/true，重开Zelda再调至90/USB断开，退出后保存90/false。截图 `out/gwemu-power-controls/{zelda,mario}-desktop.png` 已人工确认实际OFW画面。

## 固件观察

可重复入口为 `tests/test_gwemu_power_firmware.py`，显式设置 `GNW_FIRMWARE_POWER_TEST=1` 与最终 `GWEMU_BINARY`。每组复制内部/外部Flash、bank2、SD后挂载；测试断言源前后哈希一致。初始电量80%、USB接入、两个周期均0。运行至少3秒，Retro-Go两组按left+game启动；暂停后采样，再改为电量30%/USB断开。四组ADC从12600到11600，PA2/PE7从低到高。

| 配置 | VTOR | 最终截图 |
| --- | --- | --- |
| Mario OFW | 0x08000000 | PRESS TIME BUTTON |
| Zelda OFW | 0x08000000 | PRESS TIME BUTTON |
| Flash-only Retro-Go | 0x08100000 | 坦克游戏选项菜单 |
| SPI1 SD Retro-Go | 0x08100000 | Atari7800 ROM页与首次news弹窗，充电图标可见 |

人工查看拼图为 `out/gwemu-power-controls/firmware-montage.png`。最初捕获过早时Retro-Go两组仍显示OFW开场，随后增加启动组合键、观察时间与VTOR断言并重跑4项通过。最终每组 `firmware/<name>/power.json` 保存源哈希、MMIO、VTOR、像素数及观察时间，`screen.ppm` 保存实际画面。截图与输入读回不代表guest百分比滤波、完整游戏或SD写回验收。

## 冷启动证据与后续门槛

原生测试通过既有 HMP `gnw-cold-cycle` 验证六个SRAM区（DTCM、AXI、AHB1/2、SRD、backup）清零、内部Flash和UID保留、电源输入保持，以及750ms后POWER按下、200ms后释放。没有新增桌面冷启动操作。

这些证据不涵盖外部Flash、ITCM seed正确性、全部外设、RDP/选项字节转换、RTC backup/休眠恢复或真实电源域失电。后续继续验收电池物理断开、完整冷启动/软件SPI、完整Flash即时存档、管理RAM固件、音质/延迟/实时限速；OSPI与未支持容量继续拒绝。阶段二备份迁移和阶段三当前会话发现/管理交接仍未实施。

本地日志为 `out/gwemu-power-final-native-tests.log`、`out/gwemu-power-final-firmware-tests.log`、`out/gwemu-power-final-desktop-tests.log`、`out/gwemu-power-e2e.log`、`out/gwemu-power-legacy-e2e.log`、`out/gwemu-power-desktop-build.log`。审查记录为 `out/gwemu-power-{native,desktop,final}-review.txt`。不提交ROM或实验产物；主仓库只本地提交功能分支，不切换默认、不归档旧fork、不读取或覆盖产品session/旧slots。
