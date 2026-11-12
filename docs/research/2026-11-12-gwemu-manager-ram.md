# gwemu 上的 gnwmanager RAM 管理固件验收

日期：2026-11-12。本轮在临时副本上使用实际 GDBBackend、GnW API 和源码构建的 RAM 固件，验证管理邮箱、Flash、HASH、RTC、显示、应用恢复启动和两种 SD 接线。各任务的独立规格及质量审查已通过，干净提交和产物已固定；最终复验及整体审查记录见下文。默认仍为 legacy；本报告不表示完整工具链或阶段一退出条件全部满足。

## 来源与构建

manager 基线为 `dec4fdc9cb027f4c0df4e18984ce2ae29ce28df2`，嵌套 gnw_patch 固定 `d3a94bf1647b9656dbc4c5db744efd2c832aa359`。已审查的传输、Flash、SD 修复提交依次为 `6bb370a`、`48ef5f3`、`7a82d653f23b5e3b5802eb4ce1e5076f94aa379b`。原生修复提交为 `ae00b68951ab44b0dffb265e3f61340d735a68e5`，在此前 gwemu `830192d221a70f2dff5fc466ac5d3c3c74bca584` 之上补接收数量、有界 byte FIFO、读取消费及 IRQ 恢复；已发布到 [orochi115/gwemu 的 gnw-emu 分支](https://github.com/orochi115/gwemu/tree/gnw-emu)，`git ls-remote` 核对完整 SHA 一致。

用户确认公开发布后，manager 修复已推送至 [orochi115/gnwmanager 的 gnw-emu 分支](https://github.com/orochi115/gnwmanager/tree/gnw-emu)，GitHub API 核对分支 SHA 为上述 `7a82d65`。该仓库是 BrianPugh/gnwmanager 的公开 fork；父仓库子模块地址已同步，原上游保留为本地 upstream remote。sibling manager 不参与本轮修改。

构建实际使用显式 `GCC_PATH=/opt/gcc-arm-none-eabi-10.3-2021.10/bin`，GCC **10.3.1**，`DEBUG=0`、`OPT=-Os`；不是宿主 PATH 上另一版 ARM GCC。独立 Python 环境为 `build/gnwmanager-python`（3.13.18），安装同一 manager 源码及固定嵌套 patch。manifest 记录 revision、dirty、tracked diff、编译设置、编译器、依赖和 ELF/bin SHA，拒绝复用不匹配的旧对象目录。

干净 manager 产物 `build/gnwmanager-ram-release/gnwmanager.bin` 为 **49,440 bytes**，SHA-256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`。干净原生产物 `build/gwemu-manager-ram/qemu-system-arm` SHA-256 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`。两份 manifest 均记录 clean source、上述完整 revision 和实际产物 SHA，桌面开发入口已指向新原生产物。此前 `gwemu-manager-sd-guarded`、单寄存器和未完成 guard 的构建保留用于失败复现，不能作为当前产物。旧 gwemu 存档仍按实际可执行文件 SHA 拒绝跨构建读取，原文件保留。

## GDB 与安全范围

实际 ARM M-profile 描述指定 xpsr=25，而旧 backend 固定16会读到错误。现在只读取 ARM core/m-system 的必要描述；真实 MSP 与活动 SP 区分，MSP 写入仅在 CONTROL/IPSR 证明 MSP 活动时使用可写 r13。不能写 inactive MSP 时明确报错。无描述的兼容 alias 限于 fresh reset-and-halt；断连重开清除旧描述。实际 Thumb guest 切换到 PSP 的回归证明二者没有混淆。

连接声明 `xmlRegisters=arm`；实际 PacketSize=131104 足以承载现有4096-byte传输块。编码线字节 checksum、escape/RLE、精确寄存器长度、短包、断连、有限 ACK 重试和不可因进展重置的命令期限均检查。错误不能偷偷继续执行；无电源下 connect/resume/reset 的实际计数器测试不执行 guest。

宿主在 acquiring/submitting context 前拒绝负对齐偏移、start 等于/超过容量、end 越界、padding/擦除取整后越界，以及外部 HASH 非正 size 或越界。内部 bank 各256 KiB，实际 C 固件要求 program/erase 按8192-byte扇区；部分 erase 在宿主按该契约取整。外部容量与4096-byte擦除粒度从实际固件邮箱读取。保留显式 `(offset=0,size=0,whole_chip=True)`；合法空 program/flash 是 no-op，零长度 HASH/普通 erase 仍报错。

## 实际 Flash 与恢复启动

1、4、64 MiB 合成 Flash 及 copied Mario、Zelda、Flash-only Retro-Go 全部进入真实 IDLE。每个实际 Flash worker 验证50个非法请求未增加 context counter 或改变 ready，并检查整份 backing 副本哈希没有变化。覆盖三个 bank 的合法末块、内部/外部擦除、raw/compressed program；合成副本另执行 whole-chip erase。两个270336-byte外部高层 flash 分别用高可压缩及确定性不可压缩数据跨多个 context；单次低层 program >256 KiB 被拒绝。

固件执行 SRAM、解压及 Flash bank 的 HASH 校验；外部 read_hashes 与独立 Python target readback digest 一致。合成退出重开后，五个最终范围和整份 backing-copy 哈希相符。真实镜像仅在临时副本将短 bank 补 `ff` 至256 KiB。改动范围通过实际 GnW.flash 全部恢复，独立读回字节并比较完整 normalized copy SHA 后，才使用受支持 start 命令加载向量/继续。复位先清 LTDC，再取得游戏画面；Retro-Go 另要求 bank2 VTOR，排除沿用 manager 画面的假成功。

每个实验由父 harness 拥有原生实例，API worker 使用仅 loopback 的 GDB 和独立 QMP monitor。应用显示/输入观察也在同一个受监督 worker 内：Flash完整操作总期限180秒，初始连接/启动30秒，SD各完整API阶段240秒。超时 terminate/kill/wait worker，finally quit/kill/wait native 并清 socket、完整检查源哈希。故意永不显示的 guest 证明启动观察1秒总期限后两进程都被回收；manager内部随状态进展重置的 timeout 不代替父总期限。

## SD 的正确层修复与证据

SPI1 旧模型在 TXDR 收到字节后只置 RXP，不置 HAL实际轮询的 RXPLVL/FRLVL；RXDR 读取也不清数量/IRQ。实际 hspi1_ErrorCode=HAL_SPI_ERROR_TIMEOUT，导致 mount 失败。当前 manager FIFO_THRESHOLD_01DATA 使用 byte access，因此最初的 packed TXDR 假设已排除。原生按 RX FIFO 实际剩余数量报告 RXPLVL/RXWNE，读取/disable/reset 更新 availability，并重新计算 IRQ。实际 Retro-Go spi_xfer 在 TXDR 写入前缓存 SR，可能先发送下一个字节再消费上一个；只保留单 RXDR 再清 RXP 会覆盖未读数据，已由 copied SD 冷循环/RTC/game 失败及 two-unread-byte RED 证明。现在有界16-byte接收 FIFO 保持顺序，超过容量保留旧未读数据；没有扩展 generic packed TX、frame size 或完整 OVR/threshold 时序。FIFO array/head/count 纳入 VMState v3，支持 v2 的 unread-byte register 转换；post-load 检查索引/数量，非法值清空后失败，避免暂停后的 MMIO 诊断触及非法索引。真实 SSI queue order、cached-SR pump、wrap/overflow、非空 FIFO raw migration、IRQ、v2转换及 malformed-state 拒绝均有回归。该字段兼容不改变桌面绑定实际 binary SHA、拒绝不同构建状态的约束；instant states 仍拒绝任何 SD。

OSPI 的旧 manager read 驱动只等首块 token，每块后固定丢弃10 bytes；实际卡流是 CRC2、可变等待及下一 token，从第二块开始读错。原实验写20480 bytes后独立 mtype 正确，而 guest读回首错512，定位为读取驱动。现在每块分别有界等待 data token，消费恰好CRC2；错误/超时仍 CMD12 停多块传输并恢复 GPIO/OSPI 映射。编译实际 C read routine 的 wire fixture 覆盖单/多块、不同块内容、延迟/error token、timeout、command/STOP失败与 cleanup。没有修改原生 Nac 迎合旧10-byte常量。

sd_list_dir 原先先保存错误再释放邮箱、等 IDLE，随后重新读取 status 导致错误丢失为成功空目录。现在 cleanup 后抛保存的错误，保留明确的 truncated-list警告。真实无卡返回 BAD_SD_FS_MOUNT，真实缺失目录返回 BAD_SD_DIR；之后仍能正常列目录。

spi1/ospi 各在 copied1 GiB card 上实际写入/读回1037及270336 bytes。大文件有两个 write context，数据区分各 sector；写入经过固件 HASH，文件哈希来自实际 sd_read_file 读回及独立 Python摘要。每种接线分三次独立实例完成 write、重开 verify、再重开 delete；每次退出后用独立 `mdir -i copy@@1M` 确认 FAT 仍可读，`mtype` 比对 bytes/SHA或确认已删除。小文件 SHA-256 为 `30369692fbc3a52c56b18a243101e70d5e427c60a9b8f31691e1ca3f748c0cd6`，大文件为 `2c4ed0b3cc375d674163646de0d9a8159e92d963655348bd9e81a63674d1985b`，两种接线的 guest 和独立 FAT 结果一致。不能把 guest读回替代磁盘持久化证据。对旧原生产物重跑 SPI1场景仍失败 BAD_SD_FS_MOUNT，修复产物通过。

## 复现与验证记录

从根目录运行；缺少本地真实 ROM/card 时明确 skip，opted-in合成测试缺少构建或固件manifest会失败。

```sh
GCC_PATH=/opt/gcc-arm-none-eabi-10.3-2021.10/bin \
  GNWMANAGER_BUILD_DIR="$PWD/build/gnwmanager-ram-release" \
  scripts/build_gnwmanager_acceptance.sh
GWEMU_BUILD_DIR="$PWD/build/gwemu-manager-ram" sh scripts/build_gwemu.sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  build/gnwmanager-python/bin/python -m pytest -q \
  tests/test_gwemu.py tests/test_gwemu_desktop.py tests/test_gwemu_power.py \
  tests/test_gwemu_softspi.py tests/test_gwemu_supply.py tests/test_gwemu_rtc.py \
  tests/test_gwemu_savestate.py tests/test_gwemu_savestate_runtime.py \
  tests/test_gwemu_savestate_peripherals.py tests/test_gwemu_manager_spi.py
GNW_FIRMWARE_COLD_TEST=1 GNW_FIRMWARE_SUPPLY_TEST=1 GNW_FIRMWARE_POWER_TEST=1 \
  GNW_FIRMWARE_RTC_TEST=1 GNW_FIRMWARE_SD_TEST=1 GNW_FIRMWARE_STATE_TEST=1 \
  GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  build/gnwmanager-python/bin/python -m pytest -q \
  tests/test_gwemu_cold_firmware.py tests/test_gwemu_rtc_firmware.py \
  tests/test_gwemu_softspi_firmware.py tests/test_gwemu_savestate_firmware.py \
  tests/test_gwemu_power_firmware.py
GWEMU_MANAGER_TEST=1 \
  GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  GNWMANAGER_MANIFEST="$PWD/build/gnwmanager-ram-release/gnwmanager-build-manifest.json" \
  build/gnwmanager-python/bin/python -m pytest -q \
  externals/gnwmanager/tests tests/test_gwemu_manager.py tests/test_gwemu_manager_firmware.py
```

Task2 clean验证58项通过；Task3 clean及独立审查126项通过（均无skip），旧范围实现54个预期失败。Task4 native+host RED4失败3通过；actual readroutine RED6失败1通过；FIFO RED6失败3通过；非法 unread SPI1 cursor guard RED2失败。最终候选原生完整 **169项通过（23.53秒）**，含10项 SPI/FIFO 回归；copied真实固件冷启动/供电/RTC/SD/存档 **22项通过（213.97秒，无skip）**，此前4个 SPI1 Retro-Go 回归全部通过。manager及父 harness 完整 **197项通过、1项跳过（86.74秒）**，唯一跳过为原有 optional stock Mario patch fixture；包括13项新增manager针对性用例、两种接线的真实SD三阶段与无卡错误。各批次顺序执行，避免固件时限实验并发负载。最终 clean desktop/GUI检查在关闭记录中补充。

忽略目录 `out/gnwmanager-ram/` 保存 RED/GREEN、构建、manifest、copy/source hash、每组实际Mailbox/API读回、SD独立FAT、应用截图及审查证据。最终总回归后，`task4-source-after.json` 与 `source-before.json` 的10份完整bytes/SHA完全一致；进程核对仅剩原有 legacy PID16603，没有本轮 native/worker 孤儿。独立 sibling manager仍为 `dec4fdc9cb027f4c0df4e18984ce2ae29ce28df2`。产品session与原始镜像均保留；原生/manager发布时间与父仓库本地提交单独处理。

### 干净发布产物复验

最终使用本报告固定的两份 clean manifest 顺序复验：原生 **169项通过（23.48秒）**；manager及父harness **197项通过、1项既有可选fixture跳过（86.31秒）**；复制固件 **26项通过（223.73秒，无skip）**，包含冷启动、供电/RTC、两种SD接线、即时存档和额外供电输入复验。对应 `release-native-green.log`、`release-manager-green.log`、`release-firmware-green.log`。

桌面指向 `build/gwemu-manager-ram/qemu-system-arm` 后，实际供电与存档能力预检均为 true（`release-capabilities.json`）；全套 **217项通过（39.57秒）**，typecheck与build退出0。七组实际Electron回归 **7项通过（42.6秒，无skip）**，覆盖gwemu供电、预览/静音、SD、存档与重开，以及legacy自动化、窗口和存档。日志为 `release-desktop-green.log`、`release-desktop-typecheck.log`、`release-desktop-build.log`、`release-e2e-green.log`。

关闭前再次独立运行监督harness及原生SPI针对性用例 **27项通过（4.60秒，无skip）**。`release-source-after.json` 的10份原始镜像bytes/SHA与初始记录完全一致，两个子模块源码clean且产物SHA符合各自manifest；进程核对仅有原legacy PID16603，没有本轮native或API worker。最终整体审查 **APPROVED**，独立针对性复验 **23项通过（1.30秒，无skip）**，报告为 `release-final-review.txt`。公开manager和原生分支完整SHA均已核对。父仓库在 `feat/gwemu-migration` 本地提交该关闭记录及子模块引用，继续保留legacy默认；该批次通过不表示阶段二/三或旧内核退出条件全部完成。

## 未验收边界

这是功能性管理兼容验证。默认 NOR 不强制真实 WEL、1→0电气约束或实际擦写时序；内部Flash证明可写bank/PG shadow与固件代码路径，并非物理控制器精度。没有验证真实 VBAT、振荡器失电、充电器电气状态或实机 RDP/选项字节保护转换。SD真实供电/热拔插/任意错误恢复和格式化没有在本轮完整验收；即时存档仍明确不支持SD。

完整备份迁移（包括现场RAM/ITCM捕获、旧归档、选择恢复、远程拉取校验）、UI当前会话发现、单客户端调试器交接与管理期间换ROM/关闭协调属于后续阶段。没有写实机或退休旧库，不改变默认内核；进入IDLE或一次刷写不能等同完整gnwmanager工具链通过。
