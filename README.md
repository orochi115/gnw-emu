# gnw-emu：Game & Watch（Zelda / Mario）LLE 模拟器

在 QEMU 里新增 `gnw-zelda`、`gnw-mario` 两种机器，直接加载 `../firmware/` 里的两份镜像（改装机的完整备份见下文「运行改装机的完整备份」）：

- `internal_flash_backup_*.bin`：片内 Flash，映射到 `0x08000000`，从这里的向量表复位；
- `flash_backup_*.bin`：外挂 SPI NOR，经 OCTOSPI1 和 OTFDEC 映射到 `0x90000000`。

原厂固件自己完成时钟、Flash、OTFDEC 和 LCD 的初始化，并通过 CRYP 校验存档。时钟、游戏选择菜单、NES《塞尔达传说》、GB《织梦岛》以及 Mario 版都能运行。模拟器只实现固件实际用到的外设。

OTFDEC 的密钥取自固件运行时写进 `RxKEYR` 的值。仓库里不保存任何密钥，也不保存截图。

## 目录

| 路径 | 内容 |
|---|---|
| `qemu-gnw/hw/arm/gnw/` | 机器与外设源码，构建时以软链接放进 `../qemu/hw/arm/gnw` |
| `scripts/build.sh` | 克隆或复用 `../qemu`（v11.1.3），挂接 meson/Kconfig，编译 `build/qemu-system-arm` |
| `scripts/run.sh` | 带窗口运行 |
| `scripts/probe.sh` | 调试用：跑 N 秒，打印寄存器、截图，并汇总 `-d unimp` 日志 |
| `harness/` | Python headless 驱动（QMP），也提供命令行 |
| `tests/` | pytest 端到端用例；`golden.json` 只记录画面哈希 |
| `tools/gnwcrypt.py` | 离线 OTFDEC 解密，移植自 `game-and-watch-patch` 的 `crypt()`，测试里用作参照 |
| `tools/scan_mmio.py` | 结合 SVD 扫描镜像字面量池，列出固件用到的外设 |

## 复用的社区代码

- [QEMU](https://gitlab.com/qemu-project/qemu) v11.1.3：Cortex-M7（含 FPU、MPU）、NVIC、SysTick、TCG、icount、QMP、gdbstub、图形控制台、`crypto/aes`、`unimplemented-device`。
- [STMicroelectronics/stm32h7xx-hal-driver](https://github.com/STMicroelectronics/stm32h7xx-hal-driver)（已克隆到 `../stm32h7xx-hal-driver`）：OTFDEC 的 KEYCRC 算法，以及 CRYP GCM 各阶段的软硬件约定。
- `game-and-watch-retro-go`：按键引脚（`Core/Inc/main.h`）。
- `game-and-watch-patch`：OTFDEC 计数器格式和密钥在镜像中的偏移。
- `docs/gnw-lle/svd/STM32H7B0.svd`：寄存器地址和中断号。
- [qemu.qmp](https://pypi.org/project/qemu.qmp/)：Python 侧的 QMP 客户端。

## 构建

```sh
brew install ninja meson pkg-config glib pixman jpeg-turbo
python3 -m venv .venv && .venv/bin/pip install qemu.qmp pytest pillow pycryptodome
scripts/build.sh
```

`build.sh` 会改动 `../qemu` 的两处：在 `hw/arm/meson.build` 里加 `subdir('gnw')`，在 `hw/arm/Kconfig` 里加 `source gnw/Kconfig`。两处都可重复执行。本机 `/opt/devkitpro` 自带的 `pkg-config` 找不到 Homebrew 的 glib，所以脚本固定使用 `/opt/homebrew/bin/pkg-config`。

## 运行（窗口）

```sh
scripts/run.sh zelda      # 或 mario
```

| 键盘 | 按键 |
|---|---|
| 方向键 | 十字键 |
| X / Z | A / B |
| G / T / P | GAME / TIME / PAUSE |
| O | POWER |
| Return / Tab | START / SELECT（仅 Zelda） |
| - / = | 电量 −10% / +10% |
| C | 插上 / 拔掉 USB 电源 |

存档写到 `out/<model>_flash.bin`。第一次运行时从 dump 复制，`firmware/` 下的文件不会被改动。

## 运行改装机的完整备份（原厂 + Retro-Go 双系统）

用 `game-and-watch-backup/gnw_full_backup.py` 做出的备份（`bank1.bin`、`bank2.bin`、`ext.bin`）可以直接运行：

```sh
B=../game-and-watch-backup/backups/full_YYYYMMDD_HHMM
INTERNAL=$B/bank1.bin EXTERNAL=$B/ext.bin BANK2=$B/bank2.bin \
    OVERLAY=out/device_flash.bin scripts/run.sh zelda
```

开机进入原厂时钟。按住 **← + G**（LEFT + GAME）后，补丁过的引导程序会跳到 Bank 2 的 Retro-Go。
Retro-Go 里 G 对应游戏的 START，P（PAUSE）打开游戏菜单，T（TIME）对应 SELECT。
存档写进 `OVERLAY` 指定的文件，备份本身不会被改动。

电池：`BATTERY=30 USB_POWER=on BATTERY_LIFE_MIN=10 scripts/run.sh zelda` 这类环境变量设定开机电量、是否插着 USB、耗电和充电速度；窗口里按 `-`/`=` 调电量，按 `C` 插拔 USB。Headless 用 `GnW(battery=..., usb=..., battery_life_min=..., charge_time_min=...)`，运行中 `gw.set_battery(n)`、`gw.set_usb(True)`。注意 QEMU 在 VM 暂停时会丢弃键盘事件，脚本里要在运行时发键。

Headless 时用 `--internal/--external/--bank2`，或者 `GnW(internal=..., external=..., bank2=...)`。
`tests/test_retrogo.py` 会找最新的 `../game-and-watch-backup/backups/full_*`（也可以用 `GNW_FULL_BACKUP` 指定），没有就跳过。

## Headless 与自动化

命令行：

```sh
.venv/bin/python -m harness run --deterministic \
    "wait 3000" "shot clock.png" \
    "press game" "wait 1000" "shot menu.png" \
    "press a" "wait 3000" "shot title.png"
```

可用的步骤有 `wait MS`、`press BUTTONS [MS]`、`hold BUTTONS`、`release`、`shot FILE`、`regs`、`mem ADDR LEN FILE`；也可以用 `--script 文件` 每行写一步。其他选项：`--model mario`、`--wav out.wav`（录 SAI1 音频；不接声卡）、`--overlay`、`--log`、`--rtc`。窗口里的声音由 `scripts/run.sh` 的 `audio=on` 打开。

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
.venv/bin/python -m pytest -q tests            # 11 个用例，约 30 秒
GNW_UPDATE_GOLDEN=1 .venv/bin/python -m pytest tests   # 画面有意改变后更新哈希
```

## 外设实现情况

| 外设 | 状态 |
|---|---|
| Cortex-M7 / NVIC / SysTick / MPU / FPU | QEMU 自带 |
| ITCM、DTCM、AXI/AHB/SRD/Backup SRAM | RAM |
| 片内 Flash Bank 1 / Bank 2 | `internal=` 映射到 `0x08000000`（128 或 256 KiB）；`bank2=` 映射到 `0x08100000`（256 KiB，手册未写），不给时读出全 0xFF |
| RCC、PWR、FLASH 接口 | 寄存器可读回；就绪位跟随使能位。上电模拟「电源键从待机唤醒」（`SBF`、`WKUPF1`）；待机时按电源键会触发唤醒复位 |
| GPIO A–K、EXTI、SYSCFG | 实现。按键低电平有效，边沿经 `EXTICR` 路由到 EXTI 中断 |
| OCTOSPI1 + MX25U | 间接读写、自动轮询、内存映射；支持 RDID/RDSR/WRSR/读/页编程/扇区擦除。写入可落到 overlay 文件 |
| OTFDEC1 | 区域、nonce、密钥、KEYCRC；`0x90000000` 窗口里放的是已解密的内容，TCG 可以全速执行 |
| LTDC | 两层，支持 ARGB8888/RGB888/RGB565/ARGB1555/ARGB4444/L8/AL44/AL88 与 CLUT；按 60 Hz 产生行中断和重载中断 |
| DMA2D | M2M、PFC、混合、R2M、前景或背景固定颜色的混合（MODE 4/5），以及 CLUT 加载；前景支持 YCbCr 输入（JPEG 编解码器输出的 MCU 块格式，4:4:4/4:2:2/4:2:0） |
| JPEG 编解码器 | 只做解码，供 Retro-Go 封面流使用。收集写入 `DIR` 的数据直到 EOI，用 libjpeg 解成原始 YCbCr，按硬件格式（每个 MCU 依次输出 Y 块、Cb、Cr）从 `DOR` 读出；见到 SOS 时填好 `CONFR1–7` 并置 `HPDF` |
| DMA1/2 + DMAMUX1 + SAI1 | 送往 SAI 的流按 RCC PLL 与 SAI 分频算出的采样率（Zelda 为 44270 Hz）产生 HT/TC 中断，可录成 WAV。存储器到存储器的传输立即完成 |
| CRYP | AES-ECB/CBC/CTR/GCM，加密和解密都支持。算出的存档 GCM tag 与 dump 里两份 NVRAM 的 tag 一致 |
| TIM2–7、TIM15–17 | 计数、更新中断 |
| RTC + TAMP | 日历、亚秒、唤醒定时器、闹钟 A/B、备份寄存器 |
| ADC1/ADC2 | 转换（软件启动、连续模式、EOC/EOS 中断）、分辨率、过采样、SMPR 采样时间。通道 4 接电池分压：采样时间短时电容充不满，读数按 1−e^(−周期/4.17) 打折，所以 Retro-Go（1.5 周期）和原厂（810.5 周期）读到的数值与真机一致 |
| 电池与充电（BQ24072） | 机器属性 `battery`（0–100，默认 100）、`usb-power`、`battery-life-min`（默认 480）、`charge-time-min`（默认 180），运行中可用 `qom-set` 修改；PA2（PGOOD）、PE7（CHG）低电平有效并触发 EXTI。原厂固件：≥约 75% 显示 4 格，≤约 25% 变红，低于约 5% 开机即关机。百分比用 Retro-Go 的尺度，Retro-Go 显示的就是设定值 |
| TIM1 | 只有更新中断（Retro-Go 用它每秒读一次电量） |
| SPI2（LCD 初始化）、HSEM、CRC、DBGMCU 等 | 桩：可读回，状态位恒为就绪 |
| 其他 `0x40000000–0x5FFFFFFF` | `unimplemented-device`，读回 0；加 `-d unimp` 后会记日志 |

## 已知限制

- 窗口运行（`scripts/run.sh`，机器属性 `audio=on`）用 macOS AudioQueue 播放 SAI1，前面有 60 ms 的抖动缓冲（读空后重新攒满再播，积压超过 200 ms 就丢掉最旧的数据）。`GNW_AQ_DUMP=文件` 会把实际播放的数据存成 raw（48 kHz、16 位、双声道），可以和 `wav=` 录到的 SAI 数据对比。不设 `audio=on` 时静音；录音仍用 `wav=` 或 `--wav`。时钟界面几乎没有声音，进游戏后才有 BGM。
- SAI1 的采样率按 RCC 和 SAI 寄存器推算（Zelda 为 pll2_p 12.289 MHz，约 48004 Hz）。以前误读了 `RCC_CDCCIPR` 而不是 `RCC_CDCCIP1R` 的 SAI1SEL，得到 44270 Hz，比游戏的出声速度慢约 8%。游戏的缓冲队列因此溢出，正在播放的缓冲被改写，每 240 个采样的块尾都有杂音。
- MDMA、BDMA、I2C1、DAC、WWDG 都只是桩。
- 电量用电压线性近似，没有模拟锂电池放电曲线；0% 不会自动关机，只有原厂固件会在低电量时自己关机。
- OTFDEC 的「仅解密取指、数据读回 0」模式没有模拟，所有访问都按已解密处理。
- 定时器没有输入捕获，也没有 PWM 输出。
- 低功耗模式下 CPU 只是停在 WFI，不模拟功耗。

## 调试

```sh
scripts/probe.sh 4                     # 寄存器、截图（/tmp/gnw/shot.png）和日志汇总
build/qemu-system-arm -M gnw-zelda,internal=...,external=... -display none -s -S &
/opt/gcc-arm-none-eabi-10.3-2021.10/bin/arm-none-eabi-gdb -ex "target remote :1234"
```

启动卡住时，看 `-d unimp,guest_errors` 日志里最后被轮询的寄存器，再到 RM0455 里查对应的位。

调试用的机器属性 `adc-override=<0–65535>` 直接指定 ADC 通道 4 的稳定读数（采样打折之前），用来试探固件的电量阈值。
