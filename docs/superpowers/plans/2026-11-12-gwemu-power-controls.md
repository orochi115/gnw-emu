# gwemu 阶段一：电量与 USB 控制接入

> **For agentic workers:** Use subagent-driven-development for native implementation/review and executing-plans for desktop integration. Steps use checkbox syntax.

**Goal:** 在现有隔离开发入口中支持电量、USB 与配置的正常退出持久化，并对上游冷启动入口取得可核验的寄存器证据。

**Architecture:** 按已批准迁移设计的阶段一继续，不增加产品数据入口。原生板级电源模型显式 opt-in，默认保留上游固定 ADC/PGOOD 行为；桌面传入 session 电量、USB、虚拟时间放电/充电周期。机器 QOM 控制转化为 ADC channel4 与 PA2/PE7 充电器状态、PC8 板型 strap；只增加该板级输入，不复制旧 STM32 模型。正常关闭时先暂停运行，读取电量/USB，成功退出并 fsync 后保存；读回失败/崩溃仍标记保存不确定。即时存档继续拒绝。

**Tech Stack:** QEMU C/QOM/virtual clock、TypeScript/Vitest、pytest/QTest、Electron Playwright。

**依据:** docs/superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md。用户已授权持续推进与发布独立公开 fork；不切换默认、不发布主仓库、不归档旧 fork。

## 模型与边界

采用板级小模块，`-M gnw-h7b0,power-model=on,battery=0..100,usb-power=on/off,battery-life-min=N,charge-time-min=N`；电量/USB 可运行时写入，启用与周期仅初始化前修改。每秒虚拟时间更新百分比，0 周期禁用相应变化，暂停不消耗；0% 是现有 Retro-Go 标尺的最低电量，不能等同电池物理断开。ADC channel4 为 11000..13000，VREFINT 与其余 channel 保持既有逻辑；对应当前 bq24072 代码和旧桌面标尺。timing 与非 timing ADC 路径都使用该 channel 输入。

复用 GPIO 已有按 MODER 生效的 PC8 strap（digital input低，reset/analog/output沿用现状），不得无条件 reset拉低；PGOOD PA2 与 CHG PE7 active-low，变化经过现有 SYSCFG/EXTI 路由。GPIO/ADC reset 后应保留并重施加外部电源状态，按键不可影响充电器。默认 off 时上游行为不变。这里不模拟电源域掉电、充电器 CE 限流或真实电池曲线，验收记录明确区分。

QMP `human-monitor-command` 的 `gnw-cold-cycle` 只用于原生测试，复核六个 SRAM 清零、内部 Flash/UID 保留、电源输入与延迟 POWER 释放（完整外设/外部Flash/ITCM/RDP/RTC不在本次冷启动证据内）；不新增桌面冷启动菜单，也不据此宣称保护转换/管理固件验收完成。

## Task 1：原生板级电源模型

Files: new externals/gwemu/hw/arm/gnw_h7b0_power.{c,h}; modify hw/arm/{gnw_h7b0.c,meson.build}, hw/misc/gnw_h7b0_{adc,gpio}.c and their include/hw/misc headers; new tests/test_gwemu_power.py (reuse tests/test_gwemu_desktop.py Native helper).

- [x] 原生失败测试：startup/readback、0/50/100电量 ADC1/2 channel4、VREFINT 不变、非法范围拒绝、USB/充电 GPIO、EXTI、reset 保持、虚拟充放电及0周期暂停、默认 off 行为。
- [x] 在 f744411 固定产物记录缺属性的 RED，再实现 opt-in 板级模块与小 ADC/GPIO 外部输入接口。所有 runtime setter 校验后再修改，周期运算避免整数溢出。
- [x] 增量构建并运行原生 power +desktop+capacity；测试既有 cold-cycle 的 RAM/Flash/UID/定时按键行为并如实记录限制。
- [x] 原生规格/代码审查后固定提交，不复用旧 revision 的 build manifest；新 clean build 在 build/gwemu-power。

## Task 2：桌面控制与持久化

Files: desktop/src/core/{gwemu-command,kernel-backend,session-controller,paths}.ts; tests/unit/{gwemu-command,kernel-backend,kernel-paths}.test.ts; tests/integration/gwemu-controller.test.ts.

- [x] 参数测试 RED：power opt-in/session 值传递、源镜像不入参数；preflight 校验所需新属性；固定预览路径更新 build/gwemu-power。
- [x] backend 提供电源读写与停止前 snapshot；gwemu 开放既有电量/USB deviceAction，legacy 行为保持。
- [x] 电量/USB读改写按捕获的runtime串行，停止时阻止新操作并等待队列；正常关闭暂停再读取电源 snapshot，退出0且 fsync 后保存。快照/队列失败暂存错误，但仍发送quit、必要时kill并等待退出，清理后标记saveUncertain，不覆盖session。覆盖并发增减/USB与stop-during-action及失败后无进程、lease可复用回归；异常关闭继续不承诺持久化。
- [x] 真实控制器测试读 ADC/GPIO、修改电量/USB→停止→重开保持，失败读回/异常退出保护，source 不变、旧状态能力仍拒绝。

## Task 3：固件/桌面验收与提交

Files: desktop/tests/e2e/gwemu-preview.spec.ts; docs/desktop/gwemu-migration.md; docs/research/2026-11-12-gwemu-power-controls.md; externals/gwemu/docs/GNW_EMU_FORK.md; gitlink.

- [x] Electron 现有 device actions 电量/USB读回、停止重开；持续实际固件画面、原输入/静音/换 ROM/关闭回归。
- [x] Mario/Zelda OFW 在电源模型开启下正常可见，Flash-only 与 SPI1 SD Retro-Go 记录 guest 电量/充电状态或 MMIO证据，未支持接线继续拒绝。
- [x] final clean manifest sourceDirty=false；native/full desktop/typecheck/build 与旧默认 Electron适用回归、diff-check通过；审查差异与报告。
- [x] 发布已授权 fork，核对远程 SHA、更新gitlink、主仓库本地提交当前分支。下一批继续软件 SPI、完整状态与管理固件；不宣称全阶段完成。

## 执行记录

本批次完成，详见 docs/research/2026-11-12-gwemu-power-controls.md。计划审查要求的 PC8 模式保持、runtime 电源队列与snapshot失败仍清理进程已落实。原生 fed744e0dcd7a694443cabc1d478ff3deddfa34a 已发布并核对remoteSHA；全新build/gwemu-power sourceDirty=false。26项原生+4项真实固件、141项桌面、gwemu/legacy Electron各1项均通过。四组真实固件源哈希不变，Retro-Go两组VTOR0x08100000。物理电池断开、软件SPI、完整状态与管理验收仍待下一批；本次冷启动证据按报告限定范围。
