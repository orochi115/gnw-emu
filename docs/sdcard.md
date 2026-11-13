# 当前 Retro-Go SD 工作流（2026-11-13）

当前产品使用固定 gwemu；支持 SPI1 与 OSPI 引脚 GPIO 软件 SPI 两种接线。固件/Core/ROM/卡镜像准备脚本保留；`.gnw.json` 指定 `sdCard` 和 `sdWiring`，镜像复制到独立 gwemu session 后运行，原卡镜像不作为写入目标。SD 模式不支持桌面即时存档；固件自己的 SD 游戏存档仍可使用。

```sh
git submodule update --init externals/gwemu externals/gnwmanager
scripts/build.sh
SD_WIRING=spi1 scripts/run_sd.sh BACKUP_DIR
SD_WIRING=ospi scripts/run_sd.sh BACKUP_DIR
scripts/run_sd_update.sh BACKUP_DIR
```

也可使用工作区根目录的 `run_sd_emu.sh` / `run_sd_update_emu.sh`。`GNW_BACKUP_DIR` 指定已有完整 dump 输入目录，`SDCARD` 指定原始卡镜像；未指定时使用现有准备流程。`FRESH=1` 创建新 profile 身份，不删除原 session，且不会重建明确指定的源卡。更多可选参数见启动脚本。

当前软件验证使用 `tests/test_gwemu_softspi.py`、`tests/test_gwemu_softspi_firmware.py`、`tests/test_gwemu_manager_firmware.py` 及桌面 SD/manager 工作流；固件测试需显式 opt-in 和本机资产，不能把 skip 记为通过。[软件 SPI 报告](research/2026-11-12-gwemu-softspi-sd.md)、[manager RAM 固件报告](research/2026-11-12-gwemu-manager-ram.md)和[产品验收](research/2026-11-13-gwemu-product-acceptance.md)记录实际证据。旧 backup 工具已由 gnwmanager 替代，已有备份文件继续保留。此次迁移跳过实机验证，模拟器通过不证明真实 SD 改装兼容。

下面完整保留旧内核阶段的硬件模型、准备指令及测试记录。其 QEMU 子模块、`gnw_*` 源码和 legacy 专用测试已退出维护，使用[历史快照](research/2026-11-13-gwemu-migration-history.md)复现，不作为当前构建指令。

---

# 历史记录：Retro-Go SD（microSD 改装）支持

[sylverb/game-and-watch-retro-go-sd](https://github.com/sylverb/game-and-watch-retro-go-sd)（2.x，`external_cores` 分支）把模拟器核心、ROM、封面、存档都放在 microSD 卡上，固件只占片内 Flash Bank 2，外挂 SPI Flash 用作 ROM 缓存。gnw-emu 模拟了这套改装需要的硬件，并且跑通了完整流程：挂卡、启动器、加载核心、运行游戏、写存档，以及 bootloader 从 SD 卡升级固件。

没有实机验证：SD 卡模型是按 SD 规范和 Retro-Go 驱动的行为写的。

## 硬件模型

| 部件 | 实现 |
|---|---|
| SD 卡（`gnw_sdcard.c`） | SPI 模式 SDHC/SDXC 卡，后端是 `-drive if=sd,format=raw,file=…`。支持 CMD0/1/8/9/10/12/13/16/17/18/24/25/55/58/59 和 ACMD13/23/41/51；块寻址（OCR 置 CCS），CSD v2 按镜像大小生成；读数据令牌 0xFE，多块写令牌 0xFC/0xFD，数据响应 0xE5 后有两个忙字节；CMD12 先回一个填充字节。不校验命令 CRC，因为 Retro-Go 除 CMD0/CMD8 外都发 0x01；数据块带正确的 CRC16。QEMU 自带的 `sd-card-spi` 没有 CMD18/CMD25，所以没有用它 |
| 接法一：SPI1（默认，`sd-wiring=spi1`） | Tim Schuerewegen / hundshamer 的 Zelda v2 柔性板：PB3 SCK、PB4 MISO、PD7 MOSI，PB9 片选（低有效），PA15 卡电源。PA15 拉低时卡断电复位 |
| 接法二：OSPI 引脚软件 SPI（`sd-wiring=ospi`） | Yota9 方案：固件把外挂 Flash 的引脚切成 GPIO 位操作，CLK PB2、MOSI PB1（IO0）、MISO PD12（IO1）。Flash 的 nCS（PE11）为高时 SD 卡被选中（反相）。模型在 SCK 上升沿采样 MOSI，并通过 PD12 的外部电平输出 MISO。这种接法下 SPI1 上没有卡，固件会按自己的探测顺序退到软件 SPI |
| SPI1（`gnw_spi.c`） | STM32H7 SPI v2 主机：CR1/CR2.TSIZE/CFG1/CFG2/IER/SR/IFCR，TXDR/RXDR 支持 8/16/32 位访问，16 字节 RX FIFO；RXP、RXPLVL、RXWNE、TXP、EOT、TXTF、TXC，以及 CFG2.COMM 的全双工、只发、只收三种模式（`HAL_SPI_Transmit` 会切到只发）。每写一帧立即和卡交换一个字节 |
| DMA 握手（`gnw_dma.c`） | DMAMUX 请求号 37/38（SPI1 RX/TX）。指向 SPI1 的流不再“立即完成”，改为由 SPI 逐项搬运：从 TX 流取字节，把收到的字节写进 RX 流，NDTR 递减，HT/TC 照常触发。最后由 EOT 中断（IRQ 35）结束 HAL 的 DMA 传输 |
| GPIO 输出线（`gnw_gpio.c`） | 每个引脚一条命名输出线 `pin[port*16+pin]`，电平变化时触发；板级设备（SD 卡）接在上面 |
| FLASH 接口（`gnw_flash.c`） | 两个 Bank 都是 ROM device，可以编程和擦除：KEYR 解锁、CR.PG 收齐 16 字节 flash word 后编程（按位与）、SER+START 擦除 8 KiB 扇区、BER 擦除整个 Bank、SR/CCR。`bank1-overlay=` / `bank2-overlay=` 把每次改动写回文件 |
| 器件签名 | `0x08FFF800` 处的 96 位 UID（机器属性 `uid=`，24 位十六进制）、Flash 大小、封装。Retro-Go 用 UID 区分不同机器的 Flash 缓存索引 |
| HASH | SHA-1、SHA-256、MD5（用 GLib 计算），供核心通过 ABI 调用 `calculate_sha1_*` |
| OSPI Flash | JEDEC ID 改成真实型号：`C2 25 (0x20+log2 容量)`，64 MiB 为 MX25U51245G（`C2 25 3A`）。新增 SFDP（0x5A），Retro-Go 靠其中的容量字段确定 ROM 缓存有多大，没有它就会报 `flash_alloc: no room` |

## 一键运行

在 `GameWatch_Zelda/` 顶层（或 `gnw-emu/scripts/` 下同名去掉 `_emu` 的脚本）：

```sh
./run_sd_emu.sh                  # 直启：实机备份的 Bank 1 + SD 版 Retro-Go（Bank 2）+ SD 卡
./run_sd_update_emu.sh           # 真实安装流程：补丁原厂 + SD bootloader，从卡上升级 Bank 2
SD_WIRING=ospi ./run_sd_emu.sh   # 软件 SPI 接法
FRESH=1 ./run_sd_update_emu.sh   # 新身份回到升级前，保留旧存档（未指定源卡时重做新版卡）
```

缺什么就先准备：QEMU、Retro-Go SD 固件、核心（默认下载 release；`CORES_FROM=source` 时用 `build_cores.sh` 从源码编译）、卡镜像，升级流程还会准备补丁固件。`ROMS=`、`SYSTEMS=nes,gb`、`SDCARD=` 以及 `BATTERY=` 等选项见脚本开头的注释。

## 准备（分步）

依赖都在 `externals/` 下，以子模块形式存放：

| 子模块 | 用途 |
|---|---|
| `gwemu` | orochi115/gwemu `gnw-emu` 分支，当前模拟内核 |
| `retro-go-sd` | orochi115/game-and-watch-retro-go-sd `gnw-emu` 分支（基于 sylverb external_cores） |
| `game-and-watch-patch` | orochi115 fork `gnw-emu` 分支：给原厂固件打 `--sd-bootloader` 补丁 |
| `cores/*-retro-go-sd`、`cores/game-and-watch-bootloader` | sylverb 上游，固定在 release tag |
| `gnwmanager`、`stm32h7xx-hal-driver` | 备份/刷机工具与 HAL 参考；传统 Retro-Go 源码已退役 |

```sh
git submodule update --init externals/gwemu       # 其他子模块由各脚本按需初始化
brew install mtools keystone
python3 -m venv ../.venv-rgsd && ../.venv-rgsd/bin/pip install -r externals/retro-go-sd/requirements.txt

scripts/build_retrogo_sd.sh      # 固件、sd_content/、retro-go_update.bin（Zelda，Bank 2）；GCC_PATH=… 可指定工具链
scripts/fetch_cores.sh           # 下载核心与 SD bootloader → out/dl/<core>/x/{cores,bios}/…, out/dl/bootloader/
#   或者
scripts/build_cores.sh           # 从源码编译同一批文件，并逐字节比对 release（见下文）
scripts/make_sd_image.py out/sd/sdcard.img --assets local/retrogo-assets/media
#   --systems nes,gb    只放部分系统
#   --with-update       把 retro-go_update.bin 放到根目录，供升级流程使用
scripts/build_sd_patch.sh && scripts/make_sd_dualboot.py out/sd/dualboot   # 升级流程用的 Bank 1 和 ext
```

`make_sd_image.py` 的处理：ROM 放到 `/roms/<系统>/`；旧版的 `.img` 封面（就是 JPEG）放到 `/covers/<系统>/`；`.ggcodes` 放到 `/cheats/<系统>/`；跳过预压缩的 `.lzma`。核心按各自 CORE 头里声明的目录名（nes、gb、md……）匹配 ROM 目录。ROM 从不进 git。

### 从源码编译核心（`build_cores.sh`）

10 个核心和 SD bootloader 都在 `externals/cores/` 下，固定在 `fetch_cores.sh` 下载的那些 release tag 上。编译环境与上游 CI 完全一致，所以产物和 release 逐字节相同：
- **核心**：用 `sylverb/retro-go-sd-builder:v1.5`（Arm GNU Toolchain 15.2.rel1，按 digest 固定）执行 `make all CORE_VERSION=<tag>`；blueMSX 还要执行 `make bios`。然后用仓库自带的 `scripts/stage_release.py` 打出和 release 相同的 SD zip 并解开。
- **bootloader**：用 Arm GNU Toolchain 13.3.rel1（x86_64 Linux，缓存在 `out/toolchains/`），以 `DEBUG=0` 分别编出 0x08000000 版和 0x08032000 版。

两者都在 linux/amd64 容器里运行（Docker Desktop，Apple Silicon 上走 Rosetta）。产物写到 `out/dl`，布局与 `fetch_cores.sh` 相同。`VERIFY=1`（默认）时会把 release 下载到 `out/dl-release`，再逐个文件 `cmp`。只编译部分可以写 `scripts/build_cores.sh fceumm bootloader`。

本地编译 Retro-Go 固件的注意事项：
- x86 版 GCC 10.3 的可执行文件带 Chrome 下载留下的 quarantine 属性，第一次运行会被 macOS 拦截，需要在系统设置里逐个放行。Homebrew 的 `arm-none-eabi-gcc` 没有 newlib，用不了。
- GCC 10.3 的 ld 不认识 `--no-warn-rwx-segments`，`gnw-emu` 分支的 `Makefile.common` 会先探测链接器再决定是否加这个选项。
- `make -j` 时 firmware_update 子工程会和编译规则抢着下载 HAL，`build_retrogo_sd.sh` 会先把两边的 SDK 下载好。
- keystone 的 Python 包不带 arm64 动态库。`build_sd_patch.sh` 会设置 `DYLD_LIBRARY_PATH=/opt/homebrew/lib`，配合 `brew install keystone` 使用。

## 运行

### 直启：沿用实机的双系统备份，Bank 2 换成 SD 版

```sh
scripts/run_sd.sh ../game-and-watch-backup/backups/full_20261104_1021
```

脚本写 `out/profiles/sd-<备份名>-<接线>.gnw.json`（Bank 1 用加过元数据字的副本、Bank 2 用 SD 版 Retro-Go、`sdCard` 指向源卡镜像），再调用 `scripts/run.sh`。开机进原厂时钟，按 ← + G 进入 Retro-Go SD。`SD_WIRING=ospi` 切到软件 SPI 接法。外挂 Flash 和 SD 卡的工作副本在 `UserData/sessions/<profile id>/`，源卡不被写入。不读取或迁移旧的存档副本。

### 从 SD 卡升级（真实安装流程）

一键脚本是 `run_sd_update.sh`。手动的等价步骤如下：先用 game-and-watch-patch 做 `--sd-bootloader` 补丁（和 `gnwmanager flash-patch zelda … --bootloader` 写进机器的内容相同），再拼上 bootloader：

```sh
scripts/run_sd_update.sh
```

它在缺文件时做下面这些准备，再写 `out/profiles/sd-update-<接线>.gnw.json` 并启动。profile 里的 Bank 2 是 256 KiB 的空白镜像；刷写结果留在 `UserData/sessions/<profile id>/bank2.bin`。运行中的卡是会话里的 `sdcard.img`。

```sh
scripts/build_sd_patch.sh
scripts/make_sd_dualboot.py out/sd/dualboot
scripts/make_sd_image.py out/sd/update/card.img --assets local/retrogo-assets/media --with-update
```

流程：原厂时钟 → ← + G → 0x08032000 的 bootloader 在卡上发现 `retro-go_update.bin`，把 firmware_update 载入 RAM（VTOR=0x24000000）→ 解包 tar → 擦写 Bank 2 → 屏幕显示 “Firmware update done” → 按任意键复位 → 原厂 → ← + G → Retro-Go SD。Bank 2 的结果与 `gw_retro_go_intflash.bin` 逐字节相同。原厂固件存在时 bootloader 本身不更新，Bank 1 保持不变。

没有补丁环境时，可以用独立版 `out/dl/bootloader/gnw_bootloader.bin` 当 Bank 1，Bank 2 留空，流程相同，只是不经过原厂固件。

### Headless

```python
GnW("zelda", internal=..., bank2=..., sdcard="card.img", sd_snapshot=True,
    sd_wiring="spi1", bank1_overlay=..., bank2_overlay=...)
```

`sd_snapshot=True` 时写入只进临时快照，镜像本身不变。命令行对应 `--sdcard/--sd-wiring/--bank1-overlay/--bank2-overlay`。

## 调试

- Retro-Go 的 `printf` 写进 AHB SRAM 里的 `logbuf`（地址用 `arm-none-eabi-nm build/gw_retro_go.elf | grep logbuf` 查）：`gw.read_mem(addr, 4096)`。核心注册、ROM 缓存、存档路径都会记在里面。
- `GNW_SD_TRACE=1` 时，SD 卡的每条命令、每个写令牌和每次块写入的结果都写进 `-D` 日志。
- `fs_mounted` 和 `sdcard_hw_type`（2 = SPI1，3 = OSPI1）两个变量可以直接看出卡是否挂上、走的是哪种接法。
- 镜像可以随时用 mtools 查看：`mdir -/ -i card.img@@1M ::/data`。

## 测试

`tests/test_sdcard.py` 共 5 个用例，缺少依赖时自动跳过：
- 两种接法下各挂一次卡并启动 NES 游戏；
- Genesis 游戏：ROM 缓存进外挂 Flash，用存档槽 0 保存，再用 mtools 在镜像里找到 `.sav`；
- 独立 bootloader 的 SD 升级；
- 双系统的 SD 升级（需要先生成 `out/sd/dualboot/`）。

依赖：`externals/retro-go-sd` 的编译产物、`out/dl` 里的核心和 bootloader、[统一本地资源库](retrogo.md)、mtools，以及 arm-none-eabi-nm。

## 已知局限

- SD 卡是理想化的：没有写延迟，没有卡与卡之间的差异，CMD 不报 CRC 错误，读写不会失败（镜像越界除外）。
- 只验证过 FAT32 镜像（mtools 生成）。exFAT 在 FatFs 里是打开的，但这台 Mac 上没有生成 exFAT 镜像的工具。
- SPI 和 DMA 的传输瞬间完成；软件 SPI 接法里固件自己的 NOP 延时会照常消耗虚拟时间。
- 没有模拟 MDMA（固件没有用到）。

Electron 一键入口、资产复用与参数说明见 [launchers.md](desktop/launchers.md)。
