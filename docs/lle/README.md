# Game & Watch Color Screen：LLE 资料

目标机器是 2020 年 Mario 与 2021 年 Zelda 两台彩色 Game & Watch。主控是 STM32H7B0（Cortex-M7）。低层模拟是直接跑片内原厂固件，只模拟它碰到的硬件。

这里只放本仓库可以再分发的笔记和 SVD。意法手册、原理图和社区原文用链接，不把 PDF 放进仓库。游戏 ROM 仍在工作区的 `firmware/`（相对本仓库是 `../firmware/`）。密钥不要从片内镜像抄进文档。

## 本目录

| 路径 | 内容 |
|---|---|
| `machine.md` | 内存图、两份备份的分工、OTFDEC 区间、LTDC、第一版要桩的外设 |
| `svd/STM32H7B0.svd` | 寄存器描述。来源 [modm-io/cmsis-svd-stm32](https://github.com/modm-io/cmsis-svd-stm32) `stm32h7/STM32H7B0.svd`，文件头为 STMicroelectronics、Apache-2.0。Ghidra 加载片内固件时用这份，设备名用 `STM32H7B0` |

## 本仓库里已有、不必再复制

- `externals/game-and-watch-patch/patches/firmware.py`：外挂 Flash 的 AES-CTR 解密（`crypt()`）。Mario 密钥字段在片内偏移 `0x106F4`（16 字节）、nonce 在 `0x106E4`（8 字节）。Zelda 为 `0x165A4` / `0x16590`。
- `externals/game-and-watch-patch/patches/mario.py`、`zelda.py`：外挂 Flash 上 ROM 与资源的区间。
- `externals/game-and-watch-patch/docs/journal.md`：片内固件的 Ghidra 流程和按键处理函数。
- `externals/game-and-watch-retro-go/STM32H7B0VBTx_FLASH.ld`：ITCM、DTCM、AXI SRAM、`0x90000000` 的链接布局。
- `externals/game-and-watch-backup/openocd/target_mario.cfg`、`target_zelda.cfg`：ITCM 快照从 `0x00` 或 `0x20` 起，长度 1300。
- `../firmware/`：片内 Flash、外挂 SPI、ITCM 快照。模拟器加载前两份即可。

## 意法半导体原文

从 [STM32H7B0 文档页](https://www.st.com/en/microcontrollers-microprocessors/stm32h7b0-value-line/documentation.html) 下载。寄存器边界以 SVD 为准；位定义以 RM0455 为准。

| 文档 | 用途 |
|---|---|
| RM0455 | 内存图、NVIC、RCC、GPIO、Octo-SPI、OTFDEC、LTDC、DMA2D、定时器 |
| DS13196 | STM32H7B0VB 引脚复用与电气特性 |
| AN4861 | LTDC 帧缓冲与图层 |
| AN5281 | OTFDEC 的区域模式、CTR 计数，以及「只解密取指时，数据读回 0」 |

下面这些先不用下：

- Cortex-M7 编程手册 PM0253、Arm TRM：CPU 用现成的 M7 解释器时不需要。
- AN5188（片外执行）：讲的是自己链接到 `0x90000000` 的做法，原厂固件的拷贝和 OTFDEC 配置仍以 RM0455 和 AN5281 为准。
- AN5050（Octo-SPI）：寄存器已在 RM0455。第一版把 `0x90000000` 当成已映射的窗口，不必模拟 SPI 命令。
- MX25U8035 / MX25U3232 数据手册：同上，只有要模拟 Flash 芯片本身时才要。
- ES0478 勘误：启动卡住并且和某条勘误对得上再查。
- 液晶模组手册：画面从帧缓冲拷出，不按面板时序扫描。
- 声音应用笔记：公开资料还没确定原厂用的是 SAI、DAC 还是定时器。这要等固件跟踪，不是再下一份通用手册。

## 社区原文

- [WRansohoff/game_and_watch_fun](https://github.com/WRansohoff/game_and_watch_fun)：开机后的 SRAM 分区、GPIO / OCTOSPI / LTDC 寄存器快照、按键和 LCD 引脚。
- [GMMan/game-and-watch-decrypt](https://github.com/GMMan/game-and-watch-decrypt)：OTFDEC 与存档 AES-GCM 的区域说明。不要把密钥写进本仓库。
- [Upcycle-Electronics/game-and-watch-hardware](https://github.com/Upcycle-Electronics/game-and-watch-hardware) 的 `Images-Version-Current/`：原理图 `GnWschematic1v2.pdf`、走线扫描 `GnWtrace-final.pdf`、端口朝向引脚图 `GnWuCpinmap-port-oriented.png`。
