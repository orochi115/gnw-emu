# gwemu 电池存在与无电源执行门禁

本批实现迁移阶段一的原生供电来源模型。新增电池存在/断开控制和无电源时持续阻止 CPU 执行，沿用既有电量、USB、冷启动和隔离镜像机制。桌面控制、session 字段及固定预览产物路径尚未接入这项新能力；legacy 仍为默认内核。

## 契约

仅在 startup-only `power-model=on` 时启用。QOM `/machine` 新增可写布尔 `battery-present`（默认 true）和只读布尔 `powered`。电量 0% 与电池缺席分开；本批没有耗尽截止电压。保存的百分比独立于电池是否插入。

| 电池存在 | USB | powered | 电池变化与执行 |
| --- | --- | --- | --- |
| 是 | 否 | true | 按原速率耗电，可执行 |
| 是 | 是 | true | 按原速率充电，可执行 |
| 否 | 是 | true | 百分比冻结、ADC1/2 channel4 为 0、CHG 不有效，可执行 |
| 否 | 否 | false | CPU 停止，拒绝继续和单步 |

模型关闭时 powered 为 true，运行时更改电池存在仍像既有电量/USB 操作一样要求显式启用模型。PGOOD 始终由 USB 输入决定，保持原有 active-low 极性。

拔掉冗余来源不复位，例如先接 USB 再拔电池继续执行并保留现场。断开最后来源则同步停止 vCPU，清除 SRAM/TAMP 并冷复位；内部/外部 Flash、SD 和 UID 不作为易失状态清除。恢复任一来源同步冷复位并安排既有延迟 POWER 脉冲，但保持暂停，显式 continue 后才执行。没有旧暂停意图被自动撤销。

## 执行门禁与复位顺序

新增默认允许运行的 `MachineClass.can_run` 接口，只有此板的 opt-in 模型会拒绝执行。公共 `vm_prepare_start` 在 RESUME 事件、虚拟时钟和 runstate 变化前检查，覆盖自动启动、QMP 和 GDB 各线程继续/单步。

QMP/HMP continue 返回供电错误；GDB c/s/C/vCont 执行报文返回 E22，检查发生在修改 PC 或设置单步标记之前。中央 resume 门禁保持静默，因此无电状态 detach 只有一个 OK 回复，且不会恢复执行。调试读取、直接内存修改和重新连接仍可用。显式 HMP `gnw-cold-cycle` 也不能成为供电来源；无电时拒绝。

源字段先更新，转换门禁随后关闭，均先于可能释放 BQL 的 `vm_stop`。门禁在同步 `qemu_system_reset` 返回后才打开，确保供电写入返回前复位完成。此路径不投递异步 reset request；普通 HMP 冷循环仍保留此前的异步方式。标准 reset 清除旧 suspended 意图；此板当前没有独立可达的 VM SUSPENDED 控制入口。

转换清除旧启动交接、POWER 按下/释放定时器和待处理 UI warm-reset fault 状态；初始无电时在初始 seed 捕获后抑制 handoff 并清除 TAMP。定时器取消由源码审查建立证据，未把它另称为单独的计时验收。若停机/设备刷盘返回错误，来源变化与停止后的复位保持应用，QMP 报错，不回滚成无电运行。

## 验收证据

旧确切产物上的新增套件先出现 12 项失败（缺少 battery-present）及 1 项无回调机器测试通过，记录为 `out/gwemu-supply-red.log`。随后补充输入拒绝、自动启动和持久化重开测试。

`tests/test_gwemu_supply.py` 现有 18 项：供电真值表、缺省兼容、0% 区分、缺席时冻结电量和两个 ADC 输入、只读和非法 startup 参数、真实 TCG 计数循环、无电继续/reset/wakeup 拒绝、恢复后暂停、背靠背 restore/continue、自动启动门禁、GDB 执行报文/单步/detach/reconnect，以及两个 SD 接线的断电退出重开。

TCG 固件持续修改 DTCM 计数器：丢失最后来源后计数停止并清零，恢复后仍为零，显式继续才重新计数。背靠背请求的 RAM 标记只证明易失清除先于执行；同步 CPU 复位完成顺序由实际调用位置、转换门禁及独立源码审查证明，不把该标记测试当成独立的 CPU 复位时序证据。

重开测试仅使用合成临时镜像：调试写入两个内部 bank 和外部 Flash 标记，按真实 SPI1/软件 SPI 协议完成一个 SD 块写入，断开最终来源、退出进程，再用相同副本和显式供电参数重开，读回 Flash 标记、配置 UID 和 SD 数据。这不代表 Flash 擦写物理行为、瞬时断电中未完成 SD 写入一致性，或供电属性已存入 session。

`tests/test_gwemu_cold_firmware.py` 同时保留原有冷循环模式，并增加 `GNW_FIRMWARE_SUPPLY_TEST=1`。Mario/Zelda OFW、Flash-only/SD Retro-Go 每种各两轮失电/恢复，验证冗余来源变化保留运行和备份标记、最后来源丢失停止并清除标记、拒绝继续、恢复仍暂停。显式继续后 LTDC 必须从关闭重新启用，Retro-Go 必须重新交接到 `0x08100000`；清除备份域后完成 OFW PRESS TIME 操作，再用 Left+GAME。所有挂载镜像先复制，原始源 SHA256 在 finally 中复核不变。

原生提交：`eabbd8cc1476722a6f8d8e981189a9aede99d917`，独立仓库 [orochi115/gwemu](https://github.com/orochi115/gwemu)，分支 `gnw-emu`。干净构建 manifest：`build/gwemu-supply/gnw-build-manifest.json`，`sourceDirty=false`。Darwin arm64、Apple clang 17、Python 3.15.2。产物 SHA256：

```text
dc062a2679cc26a54f57737d5b8444dc270229c908330da32f9ece478b8ba4e8
```

该确切产物复验：

| 检查 | 结果 |
| --- | --- |
| 18 项供电 + 41 项既有原生回归 | 59 项通过 |
| 桌面单元及原生集成 | 39 文件、145 项通过 |
| 四类固件的冷循环和供电两种模式，各两轮转换 | 8 项通过 |
| 所有源镜像执行前后 SHA256 | 不变 |
| 规范、质量和最终独立审查 | APPROVED，无 Critical/Important 问题 |

日志为 `out/gwemu-supply-{build,native-final,desktop-final,firmware-final}.log`；审查为 `out/gwemu-supply-{spec,quality,final}-review.txt`。最终供电恢复截图为 `out/gwemu-supply/supply-cycle-2.png`；逐轮状态和源哈希为 `out/gwemu-supply/firmware/<profile>/supply.json`。这批未改桌面 TypeScript/Electron 流程，未重复 GUI 套件；桌面回归通过显式产物覆盖验证新原生内核。

## 重现

```sh
GWEMU_BUILD_DIR=build/gwemu-supply sh scripts/build_gwemu.sh
GWEMU_BINARY="$PWD/build/gwemu-supply/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_supply.py tests/test_gwemu.py tests/test_gwemu_desktop.py tests/test_gwemu_power.py tests/test_gwemu_softspi.py
GNW_FIRMWARE_COLD_TEST=1 GNW_FIRMWARE_SUPPLY_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-supply/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_cold_firmware.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-supply/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-supply/qemu-system-arm" npm test
```

## 未完成范围

这是离散来源和执行模型。真实 BQ24072 CE/电流限制、锂电池化学和截止电压、RTC/VBAT 常供电域、物理保护转换、突然断电中的写入一致性、桌面电池开关/session 持久化、完整 VMState/Flash 回滚、gnwmanager 当前会话接入均未完成。无电时整个 QEMU 虚拟时钟随 VM 暂停，未单独模拟常供电 RTC。既有直接 RAM 清除的翻译缓存疑虑保持为尚未建立失败 TCG 案例的后续事项。
