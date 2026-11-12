# gwemu 原生冷循环可靠性

本批按迁移阶段一补强现有 HMP `gnw-cold-cycle`，不新增桌面控制或持续断电模型。主仓库仍保留 legacy 默认内核；桌面开发预览仍用上一批 `build/gwemu-softspi`。本批原生验证产物单独放在 `build/gwemu-cold-cycle`，供后续冷启动、电池存在和管理控制接入使用。

## 修复与失败证据

旧实现第一次收到冷循环请求时才保存整个 ITCM。这个时点可能已经执行固件，因而会把运行中的工作数据或解锁载荷当成以后恢复的启动镜像。新实现改在初始 system reset 的 exit 阶段保存一次；QEMU 先完成所有 reset hold，generic loader 和 ROM 的写入发生在 hold，随后才执行 exit，固件和启动交接尚未运行。

回归在启动时加载 256 字节 ITCM，运行后改写已加载和未加载区域，并执行两轮冷循环。旧产物错误保留未加载区域的 `0x11223344`；新产物恢复启动字节并清零未加载区。已加载区域也由 QEMU loader 在 reset 时重新写入，因此该区域的读回本身不能独立证明 seed 来源；未加载区域断言和 reset 顺序共同建立证据。

现有命令声称完整断电，但没有清除 TAMP 备份寄存器。现在使用既有 backup-domain reset hook 清零 BKP0R 至 BKP31R。回归先验证普通 `system_reset` 保留两个端点的标记，再验证冷循环清零；旧产物在冷循环后仍保留标记，测试失败。

连续 POWER 脉冲测试在旧产物上已经通过：GPIO reset 释放按键，`timer_mod` 重新安排下一次按下。本批保留这个回归，不修改定时器。原有 RAM 清除、Flash/UID 保留和电源输入保留回归继续运行。

## 真实固件验收

`tests/test_gwemu_cold_firmware.py` 以 `GNW_FIRMWARE_COLD_TEST=1` 显式启用。使用 Mario/Zelda OFW 和本地 Flash-only、SD Retro-Go profile；所有内部/外部 Flash、bank2、SD 先复制到临时目录，只挂载副本，退出后重新比较全部源文件 SHA256。

每个设备先实际执行并渲染，再执行两轮冷循环。暂停状态下确认 reset 已关闭 LTDC 且 BKP0R 为零，再恢复执行；固件必须重新启用 LTDC 并渲染超过 20000 个非暗像素。Retro-Go 还必须重新将 VTOR 设置为 `0x08100000`。截图和逐轮观测写入 `out/gwemu-cold-cycle/firmware/<profile>/`。

首次验收发现 Flash/SD 冷启动停留在 OFW「PRESS TIME BUTTON」画面；此时不能用明亮画面代替 Retro-Go 成功。清空备份域后需要完成首次启动操作：等待开机画面、按 TIME，再按 Left+GAME。补齐这个真实输入步骤后，两个 Retro-Go profile 的两轮冷启动均完成 bank2 交接，截图分别显示 Flash 版游戏菜单和 SD 版 Atari 启动器。TIME 和组合键都在运行时发送并释放，停止期间不发送输入。

## 构建与验证记录

原生提交：`07baa2c1e72e85c06992a1d6486fd67168822911`，独立仓库 [orochi115/gwemu](https://github.com/orochi115/gwemu)，分支 `gnw-emu`。

干净构建 manifest：`build/gwemu-cold-cycle/gnw-build-manifest.json`，`sourceDirty=false`。Darwin arm64，Apple clang 17、Python 3.15.2。产物 SHA256：

```text
f84181012936f2ffd03b1b57e0a288a87da8184554341b1b496d5c144c3a0eaa
```

该确切产物复验结果：

| 检查 | 结果 |
| --- | --- |
| baseline、display/UID/lock/audio、电源、两种 SD 接线原生回归 | 41 项通过 |
| 桌面单元与原生集成回归 | 39 文件、145 项通过 |
| Mario/Zelda OFW、Flash-only/SD Retro-Go，各两轮冷循环 | 4 项通过 |
| 所有挂载源镜像的执行前后 SHA256 | 不变 |
| 独立代码与验收审查 | APPROVED，无 Critical/Important 问题 |

日志：`out/gwemu-cold-{build,native-final,desktop-final,firmware-final}.log`；审查：`out/gwemu-cold-final-review.txt`。第二轮截图组合：`out/gwemu-cold-cycle/final-cycle-2.png`。这批未改桌面 TypeScript 或 Electron 流程，未重复 GUI 套件；桌面回归通过显式产物覆盖验证新原生提交。

执行命令：

```sh
GWEMU_BUILD_DIR=build/gwemu-cold-cycle sh scripts/build_gwemu.sh
GWEMU_BINARY="$PWD/build/gwemu-cold-cycle/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu.py tests/test_gwemu_desktop.py tests/test_gwemu_power.py tests/test_gwemu_softspi.py
GNW_FIRMWARE_COLD_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-cold-cycle/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_cold_firmware.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-cold-cycle/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-cold-cycle/qemu-system-arm" npm test
```

## 范围与后续

本批验证显式原生冷循环后重新启动和隔离镜像安全，不等于真实电池断开。仍待实现和验收：电池存在状态、USB 与电池共同供电、无电源时持续阻止 CPU 执行、桌面冷启动入口、RDP/选项字节保护转换、gnwmanager 解锁和 RAM 管理固件。

RTC 继续采用原有 reset 时的固定 epoch 或宿主时间初始化约定；未验证物理 VBAT 丢失和保留行为。完整即时存档和 Flash 回滚也未实现。既有直接 SRAM `memset`/ITCM `memcpy` 对翻译缓存的行为另列为未证明的风险，未有失败 TCG 回归前，本批没有扩大修改。这些边界使迁移阶段一、二、三均继续保持未完成。
