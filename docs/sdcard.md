# Retro-Go SD（microSD 改装）支持

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

## 准备

```sh
# 1. Retro-Go SD 源码（git worktree，不影响原来的 checkout）
cd ../game-and-watch-retro-go
git worktree add ../retro-go-sd sylverb-sd/external_cores
cd ../retro-go-sd && git submodule update --init
python3 -m venv ../.venv-rgsd && ../.venv-rgsd/bin/pip install -r requirements.txt
brew install mtools

# 2. 编译固件、sd_content/、retro-go_update.bin（Zelda，Bank 2）
cd ../gnw-emu
scripts/build_retrogo_sd.sh          # GCC_PATH=… 可指定工具链

# 3. 下载核心与 SD bootloader（gh CLI）
scripts/fetch_cores.sh               # → out/dl/<core>/x/{cores,bios}/…, out/dl/bootloader/

# 4. 生成 SD 卡镜像（MBR + FAT32），旧版 Retro-Go 的 roms/ 可以直接用
scripts/make_sd_image.py out/sd/sdcard.img --roms ../xx/game-and-watch-retro-go/roms
#   --systems nes,gb    只放部分系统
#   --with-update       把 retro-go_update.bin 放到根目录，供升级流程使用
```

`make_sd_image.py` 的处理：ROM 放到 `/roms/<系统>/`；旧版的 `.img` 封面（就是 JPEG）放到 `/covers/<系统>/`；`.ggcodes` 放到 `/cheats/<系统>/`；跳过预压缩的 `.lzma`。核心按各自 CORE 头里声明的目录名（nes、gb、md……）匹配 ROM 目录。

本地编译的注意事项：
- x86 版 GCC 10.3 的可执行文件带 Chrome 下载留下的 quarantine 属性，第一次运行会被 macOS 拦截，需要在系统设置里逐个放行。Homebrew 的 `arm-none-eabi-gcc` 没有 newlib，用不了。
- GCC 10.3 的 ld 不认识 `--no-warn-rwx-segments`。本地 worktree 的 `Makefile.common` 改成先探测链接器支持再加这个选项（只是本地改动，没有提交到上游）。
- `make -j` 时 firmware_update 子工程会和编译规则抢着下载 HAL，`build_retrogo_sd.sh` 会先把两边的 SDK 下载好。

## 运行

### 直启：沿用实机的双系统备份，Bank 2 换成 SD 版

```sh
B=../game-and-watch-backup/backups/full_20261104_1021
INTERNAL=$B/bank1.bin EXTERNAL=$B/ext.bin \
BANK2=../retro-go-sd/build/gw_retro_go_intflash.bin \
OVERLAY=out/sd_ext.bin SDCARD=out/sd/sdcard.img scripts/run.sh zelda
```

开机进原厂时钟，按 ← + G 进入 Retro-Go SD。`SD_WIRING=ospi` 切到软件 SPI 接法。

### 从 SD 卡升级（真实安装流程）

先用 game-and-watch-patch 做 `--sd-bootloader` 补丁（和 `gnwmanager flash-patch zelda … --bootloader` 写进机器的内容相同），再拼上 bootloader：

```sh
cd ../game-and-watch-patch && git worktree add ../gnw-patch-sd HEAD && cd ../gnw-patch-sd
cp ../firmware/{internal_flash_backup,flash_backup,itcm_backup}_zelda.bin .
brew install keystone && export DYLD_LIBRARY_PATH=/opt/homebrew/lib   # keystone 的 Python 包不带 arm64 动态库
../.venv-rgsd/bin/pip install -r requirements.txt setuptools
PATH=../.venv-rgsd/bin:$PATH make GCC_PATH=… PATCH_PARAMS="--device=zelda --sd-bootloader"
cd ../gnw-emu
scripts/make_sd_dualboot.py --patch ../gnw-patch-sd/build out/sd/dualboot
scripts/make_sd_image.py out/sd/update.img --roms ../xx/game-and-watch-retro-go/roms --with-update

INTERNAL=out/sd/dualboot/bank1.bin EXTERNAL=out/sd/dualboot/ext.bin \
BANK1_OVERLAY=out/sd/b1.bin BANK2_OVERLAY=out/sd/b2.bin \
OVERLAY=out/sd/ext_ov.bin SDCARD=out/sd/update.img scripts/run.sh zelda
```

流程：原厂时钟 → ← + G → 0x08032000 的 bootloader 在卡上发现 `retro-go_update.bin`，把 firmware_update 载入 RAM（VTOR=0x24000000）→ 解包 tar → 擦写 Bank 2 → 屏幕显示 “Firmware update done” → 按任意键复位 → 原厂 → ← + G → Retro-Go SD。Bank 2 的结果留在 `BANK2_OVERLAY` 里，内容与 `gw_retro_go_intflash.bin` 逐字节相同。原厂固件存在时 bootloader 本身不更新，Bank 1 保持不变。

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

依赖：`../retro-go-sd` 的编译产物、`out/dl` 里的核心和 bootloader、旧版 ROM 目录、mtools，以及 arm-none-eabi-nm。

## 已知局限

- SD 卡是理想化的：没有写延迟，没有卡与卡之间的差异，CMD 不报 CRC 错误，读写不会失败（镜像越界除外）。
- 只验证过 FAT32 镜像（mtools 生成）。exFAT 在 FatFs 里是打开的，但这台 Mac 上没有生成 exFAT 镜像的工具。
- SPI 和 DMA 的传输瞬间完成；软件 SPI 接法里固件自己的 NOP 延时会照常消耗虚拟时间。
- 没有模拟 MDMA（固件没有用到）。
