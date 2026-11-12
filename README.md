# gnw-emu：Game & Watch（Zelda / Mario）LLE 模拟器

在 QEMU 里新增 `gnw-zelda`、`gnw-mario` 两种机器，直接加载 `../firmware/` 里的两份镜像（改装机的完整备份见下文「运行改装机的完整备份」）：

- `internal_flash_backup_*.bin`：片内 Flash，映射到 `0x08000000`，从这里的向量表复位；
- `flash_backup_*.bin`：外挂 SPI NOR，经 OCTOSPI1 和 OTFDEC 映射到 `0x90000000`。

原厂固件自己完成时钟、Flash、OTFDEC 和 LCD 的初始化，并通过 CRYP 校验存档。时钟、游戏选择菜单、NES《塞尔达传说》、GB《织梦岛》以及 Mario 版都能运行。模拟器只实现固件实际用到的外设。

OTFDEC 的密钥取自固件运行时写进 `RxKEYR` 的值。仓库里不保存任何密钥，也不保存截图。

## 目录

| 路径 | 内容 |
|---|---|
| `qemu-gnw/hw/arm/gnw/` | 机器与外设源码；`externals/qemu/hw/arm/gnw` 是指向这里的软链接 |
| `externals/` | 子模块：qemu、Retro-Go SD、各核心与 bootloader、game-and-watch-patch/backup、gnwmanager、HAL、旧版 Retro-Go（见 `docs/sdcard.md`） |
| `scripts/build.sh` | 用 `externals/qemu`（orochi115/qemu 的 `gnw` 分支 = v11.1.3 + 钩子）编译 `build/qemu-system-arm` |
| `scripts/run.sh`、`run_backup.sh` | 原版/JSON ROM 与完整 dump 一键运行 |
| `scripts/probe.sh` | 隔离运行 N 秒，输出寄存器 JSON 与截图 |
| `harness/` | Python headless 驱动（QMP），也提供命令行 |
| `tests/` | pytest 端到端用例；`golden.json` 只记录画面哈希 |
| `tools/gnwcrypt.py` | 离线 OTFDEC 解密，移植自 `game-and-watch-patch` 的 `crypt()`，测试里用作参照 |
| `tools/scan_mmio.py` | 结合 SVD 扫描镜像字面量池，列出固件用到的外设 |
| `scripts/run_sd.sh`、`run_sd_update.sh` | Retro-Go SD 一键运行：直启 / 从 SD 卡升级 |
| `scripts/build_retrogo_sd.sh`、`fetch_cores.sh`、`build_cores.sh`、`make_sd_image.py`、`build_sd_patch.sh`、`make_sd_dualboot.py` | Retro-Go SD：编译固件、下载或编译核心、生成 SD 卡镜像、打补丁、拼双系统 Bank 1（见 `docs/sdcard.md`） |
| `hwtest/` | Cortex-M7 时序测试，真机和模拟器都能跑；结果与周期精确化评估见 `docs/cycle-accuracy.md` |
| `docs/desktop/README.md` | Electron 桌面、JSON ROM 配置、自动化、日志和开发说明 |

## 复用的社区代码

- [QEMU](https://gitlab.com/qemu-project/qemu) v11.1.3：Cortex-M7（含 FPU、MPU）、NVIC、SysTick、TCG、icount、QMP、gdbstub、图形控制台、`crypto/aes`、`unimplemented-device`。
- [STMicroelectronics/stm32h7xx-hal-driver](https://github.com/STMicroelectronics/stm32h7xx-hal-driver)（已克隆到 `../stm32h7xx-hal-driver`）：OTFDEC 的 KEYCRC 算法，以及 CRYP GCM 各阶段的软硬件约定。
- `game-and-watch-retro-go`：按键引脚（`Core/Inc/main.h`）。
- `game-and-watch-patch`：OTFDEC 计数器格式和密钥在镜像中的偏移。
- `docs/lle/svd/STM32H7B0.svd`：寄存器地址和中断号。内存图与手册链接见 `docs/lle/README.md`。
- [qemu.qmp](https://pypi.org/project/qemu.qmp/)：Python 侧的 QMP 客户端。

## 构建

gwemu 迁移已建立独立构建与同镜像实验入口，默认桌面仍使用下述旧内核。新内核来源、构建命令、实验边界与进度见 [gwemu 迁移实验](docs/desktop/gwemu-migration.md)。

```sh
git submodule update --init externals/qemu
brew install ninja meson pkg-config glib pixman jpeg-turbo
python3 -m venv .venv && .venv/bin/pip install qemu.qmp pytest pillow pycryptodome
scripts/build.sh
```

qemu 子模块的 `gnw` 分支已经提交了两处钩子：`hw/arm/meson.build` 里的 `subdir('gnw')` 和 `hw/arm/Kconfig` 里的 `source gnw/Kconfig`，`hw/arm/gnw` 是指向 `qemu-gnw/hw/arm/gnw` 的相对软链接。用 `QEMU_SRC=` 指定原版 QEMU 时，`build.sh` 会自动补上这两处。本机 `/opt/devkitpro` 自带的 `pkg-config` 找不到 Homebrew 的 glib，所以脚本固定使用 `/opt/homebrew/bin/pkg-config`。

## 运行（Electron 窗口）

```sh
cd desktop
npm ci
npm run build
npm run dev
```

也可在项目根目录使用 `scripts/run.sh zelda` / `mario` / `FILE.gnw.json`。主窗口通过“文件 → 加载 ROM…”和“制作 ROM…”操作。制作只组合已有的 Flash/SD 镜像，不编译固件。源镜像不修改，新格式存档位于 `UserData/sessions/<id>/`。即时存档支持 F5 保存、F8 读取及 0–9 槽位，完整恢复 flash；SD 模式不支持，外部 flash 上限 64 MiB。见 [即时存档说明](docs/desktop/savestates.md)。支持简体中文/英文，`--language=en` 可覆盖。一键原版/dump/SD 命令见 [启动脚本](docs/desktop/launchers.md)，完整说明见 [桌面应用文档](docs/desktop/README.md)。

“编辑 → 自定义按键…”可配置共享的键盘、手柄映射、连发和热键，保存到应用 `settings.json`。详细操作见 [自定义按键](docs/desktop/controls.md)。下表为默认键盘配置。

| 键盘 | 设备操作 |
|---|---|
| 方向键 | 十字键 |
| X / Z | A / B |
| G / T / P / O | GAME / TIME / PAUSE / POWER |
| Return / Tab | START / SELECT |
| - / = | 电量 −10% / +10% |
| C | 插上 / 拔掉 USB 电源 |

亮度由已有 DAC/GPIO/LCD 模型合成，Electron 显示 QEMU 完整像素，不改变游戏颜色。宿主音频由 QEMU 音频后端播放。

## 完整设备备份

`../run_backup_emu.sh BACKUP_DIR` 将 bank1.bin、bank2.bin、ext.bin 组合为 JSON 配置。新脚本不迁移旧存档；`FRESH=1` 创建新 UUID，保留以前的存档。父目录脚本自动选择 Electron worktree，`GNW_EMU_DIR=/path/to/project` 可显式覆盖。

原厂时钟中按住 **← + G** 进入 Retro-Go；Retro-Go 中 G 对应 START、T 对应 SELECT、P 打开游戏菜单。Headless 固件/设备测试仍使用 Python `GnW`，参数和测试隔离行为不变。

## Retro-Go SD（microSD 改装）

支持 sylverb 的 Retro-Go SD 2.x，SD 卡的两种接法都支持：SPI1（默认），以及复用外挂 Flash 引脚的软件 SPI（`SD_WIRING=ospi`）。`scripts/run_sd.sh` 和 `scripts/run_sd_update.sh` 把 Bank、卡镜像和接线写进 `out/profiles/` 下的 profile 再启动。核心、ROM、封面、存档都在卡上，ROM 缓存用外挂 Flash。升级流程里 bootloader 从卡上的 `retro-go_update.bin` 刷写 Bank 2，结果留在该 profile 的会话里。

```sh
scripts/run_sd.sh [备份目录]        # 直启：备份的 Bank 1 + SD 版 Retro-Go + SD 卡（缺的产物会先准备好）
scripts/run_sd_update.sh           # 补丁原厂 + SD bootloader，从卡上的 retro-go_update.bin 安装 Retro-Go
SD_WIRING=ospi scripts/run_sd.sh   # 软件 SPI 接法
```

编译、镜像生成、升级流程和调试方法见 `docs/sdcard.md`。

## Headless 与自动化

命令行：

```sh
.venv/bin/python -m harness run --deterministic \
    "wait 3000" "shot clock.png" \
    "press game" "wait 1000" "shot menu.png" \
    "press a" "wait 3000" "shot title.png"
```

可用的步骤有 `wait MS`、`press BUTTONS [MS]`、`hold BUTTONS`、`release`、`shot FILE`、`regs`、`mem ADDR LEN FILE`；也可以用 `--script 文件` 每行写一步。其他选项：`--model mario`、`--wav out.wav`（录 SAI1 音频；不接声卡）、`--overlay`、`--log`、`--rtc`。窗口里的声音由 settings.json 的 audio 开关控制，默认开启。

Python：

```python
from harness import GnW
with GnW("zelda", deterministic=True) as gw:
    gw.run(3000)                  # 3 秒虚拟时间
    gw.press("game", 150, 1000)
    img = gw.frame()              # PIL.Image
    gw.read_mem(0x24000000, 16)
    print(hex(gw.pc), gw.hmp("info registers"))
```

时间以虚拟时间计。机器提供两个 QOM 属性：`stop-after-ms` 让 VM 在给定的虚拟时间后暂停，`vtime-ns` 读取当前虚拟时间。`buttons` 是按键位掩码，运行中可以用 `qom-set /machine buttons <mask>` 修改。

- `deterministic=True` 时加 `-icount shift=2,sleep=off`，每条指令记 4 ns，约 250 MIPS。相同的输入得到逐字节相同的 RAM 和画面。空闲时虚拟时间直接跳到下一个事件，标题画面下大约是实时的 11 倍速。
- 不加这个选项时，虚拟时间跟随真实时间。但这时定时器由主循环按宿主时间触发：主循环晚了，周期定时器会在一轮里连续补发，NVIC 把它们合并成一次。Retro-Go 下 SysTick 因此丢了约三分之一的中断，它用 `HAL_GetTick()` 调节帧节奏，结果漏掉 DMA 半区，声音出现杂音。
- `realtime=True`（`scripts/run.sh` 默认使用）：`-icount shift=2,sleep=off` 加机器属性 `realtime=on`。每个定时器都在精确的指令数触发，机器每 1 ms 虚拟时间检查一次，虚拟时间跑到真实时间前面就睡眠等待。窗口里的行为与 `deterministic=True` 一致（同一操作序列下 SAI 输出逐字节相同），速度与真实时间一致。VM 暂停后或宿主落后超过 50 ms 时重新对齐，不会加速追赶。
- RTC 默认从 `2026-01-01 09:00` 开始，用的是 `clock=vm`；`--rtc host` 改用本机时间。

测试：

```sh
.venv/bin/python -m pytest -q tests            # 33 个用例，约 4 分钟（SD 用例缺依赖时跳过）
GNW_UPDATE_GOLDEN=1 .venv/bin/python -m pytest tests   # 画面有意改变后更新哈希
```

## 外设实现情况

| 外设 | 状态 |
|---|---|
| Cortex-M7 / NVIC / SysTick / MPU / FPU | QEMU 自带 |
| DWT | 只有 `CTRL.CYCCNTENA` 和 `CYCCNT`：按 280 MHz 把虚拟时间折算成周期（`-icount shift=2` 时每条指令 1.12 周期） |
| ITCM、DTCM、AXI/AHB/SRD/Backup SRAM | RAM |
| 片内 Flash Bank 1 / Bank 2 | `internal=` 映射到 `0x08000000`（128 或 256 KiB）；`bank2=` 映射到 `0x08100000`（256 KiB，手册未写），不给时读出全 0xFF |
| FLASH 接口 | 解锁、按 16 字节 flash word 编程、扇区擦除和整 Bank 擦除；`bank1-overlay=` / `bank2-overlay=` 把改动写回文件 |
| RCC、PWR | 寄存器可读回；就绪位跟随使能位。上电模拟「电源键从待机唤醒」（`SBF`、`WKUPF1`）；待机时按电源键会触发唤醒复位。深度睡眠：QEMU 的 NVIC 不保存 `SCR.SLEEPDEEP`，机器自己保存一份；内核在深度睡眠（STOP/STANDBY）里时屏蔽 SysTick，电源键经 WKUP1 把内核从 STOP 唤醒（Retro-Go SD 的睡眠）。LCD 供电（PD4、PD1）关闭时画面全黑 |
| SPI1 + microSD 卡 | STM32H7 SPI v2 主机，支持 DMA（DMAMUX 37/38）；SPI 模式 SDHC 卡，也可以接在 OSPI 引脚上走软件 SPI。见 `docs/sdcard.md` |
| HASH、器件 UID | SHA-1/SHA-256/MD5；`0x08FFF800` 处的 UID（`uid=`） |
| GPIO A–K、EXTI、SYSCFG | 实现。Zelda 板上 PC8 接地（板型识别脚，原厂据此从 PC5 读 TIME、把 PA2 当充电 PGOOD）。按键低电平有效，边沿经 `EXTICR` 路由到 EXTI 中断 |
| OCTOSPI1 + MX25U | 间接读写、自动轮询、内存映射；支持 RDID（真实 ID：`C2 25 0x20+log2 容量`）、SFDP、RDSR/WRSR、读、页编程、扇区擦除。写入可落到 overlay 文件 |
| OTFDEC1 | 区域、nonce、密钥、KEYCRC；`0x90000000` 窗口里放的是已解密的内容，TCG 可以全速执行 |
| LTDC | 两层，支持 ARGB8888/RGB888/RGB565/ARGB1555/ARGB4444/L8/AL44/AL88 与 CLUT；按 60 Hz 产生行中断和重载中断 |
| DAC1 / DAC2 与背光 | 通道启停、8 位及左右对齐 12 位数据、双通道写入、DOR 读回、软件触发和复位。背光取 DAC1_OUT1；各固件同步设置背光通道。暂不模拟 DMA、外部触发、校准或波形生成 |
| DMA2D | M2M、PFC、混合、R2M、前景或背景固定颜色的混合（MODE 4/5），以及 CLUT 加载；前景支持 YCbCr 输入（JPEG 编解码器输出的 MCU 块格式，4:4:4/4:2:2/4:2:0） |
| JPEG 编解码器 | 只做解码，供 Retro-Go 封面流使用。收集写入 `DIR` 的数据直到 EOI，用 libjpeg 解成原始 YCbCr，按硬件格式（每个 MCU 依次输出 Y 块、Cb、Cr）从 `DOR` 读出；见到 SOS 时填好 `CONFR1–7` 并置 `HPDF` |
| DMA1/2 + DMAMUX1 + SAI1 | 送往 SAI 的流按 RCC PLL 与 SAI 分频算出的采样率（Zelda 为 44270 Hz）产生 HT/TC 中断，可录成 WAV。存储器到存储器的传输立即完成 |
| CRYP | AES-ECB/CBC/CTR/GCM，加密和解密都支持。算出的存档 GCM tag 与 dump 里两份 NVRAM 的 tag 一致 |
| TIM2–7、TIM15–17 | 计数、更新中断 |
| RTC + TAMP | 日历、亚秒、唤醒定时器、闹钟 A/B、备份寄存器 |
| ADC1/ADC2 | 转换（软件启动、连续模式、EOC/EOS 中断）、分辨率、过采样。通道 4 接电池分压，读数与采样时间无关：实测原厂（810.5 周期、1024 倍过采样）和 Retro-Go 用同一刻度，接近满电约 13000 |
| 电池与充电（BQ24072） | 机器属性 `battery`（0–100，默认 100）、`usb-power`、`battery-life-min`（默认 480）、`charge-time-min`（默认 180），运行中可用 `qom-set` 修改；PA2（PGOOD）、PE7（CHG）低电平有效并触发 EXTI。原厂固件：≥约 75% 显示 4 格，≤约 25% 变红，低于约 5% 开机即关机。百分比用 Retro-Go 的尺度，Retro-Go 显示的就是设定值 |
| TIM1 | 只有更新中断（Retro-Go 用它每秒读一次电量） |
| SPI2（LCD 初始化）、HSEM、CRC、DBGMCU 等 | 桩：可读回，状态位恒为就绪 |
| 其他 `0x40000000–0x5FFFFFFF` | `unimplemented-device`，读回 0；加 `-d unimp` 后会记日志 |

## 已知限制

- 窗口运行用 QEMU 音频后端播放 SAI1，保留有界的 PCM 队列；不依赖 Apple 专用 API。声音生成与 WAV 捕获仍由原有 SAI/DMA 模型完成。时钟界面通常静音，游戏中有 BGM。
- SAI1 的采样率按 RCC 和 SAI 寄存器推算（Zelda 为 pll2_p 12.289 MHz，约 48004 Hz）。以前误读了 `RCC_CDCCIPR` 而不是 `RCC_CDCCIP1R` 的 SAI1SEL，得到 44270 Hz，比游戏的出声速度慢约 8%。游戏的缓冲队列因此溢出，正在播放的缓冲被改写，每 240 个采样的块尾都有杂音。
- MDMA、BDMA、I2C1、DAC、WWDG 都只是桩。
- 电量用电压线性近似，没有模拟锂电池放电曲线；0% 不会自动关机，只有原厂固件会在低电量时自己关机。
- OTFDEC 的「仅解密取指、数据读回 0」模式没有模拟，所有访问都按已解密处理。
- 定时器没有输入捕获，也没有 PWM 输出。
- 低功耗模式下 CPU 只是停在 WFI，不模拟功耗。
- 时序是功能级的：CPU 和定时器时钟固定为 280 MHz，原厂固件实际跑在 136 MHz，所以它的 SysTick 节拍快了一倍；每条指令固定 1.12 周期；DMA、DMA2D 瞬间完成。真机测量和差距评估见 `docs/cycle-accuracy.md`。

## 调试

```sh
scripts/probe.sh 4                     # 寄存器、截图（/tmp/gnw/shot.png）和日志汇总
build/qemu-system-arm -M gnw-zelda,internal=...,external=... -display none -s -S &
/opt/gcc-arm-none-eabi-10.3-2021.10/bin/arm-none-eabi-gdb -ex "target remote :1234"
```

启动卡住时，看 `-d unimp,guest_errors` 日志里最后被轮询的寄存器，再到 RM0455 里查对应的位。

调试用的机器属性 `adc-override=<0–65535>` 直接指定 ADC 通道 4 的稳定读数（采样打折之前），用来试探固件的电量阈值。
