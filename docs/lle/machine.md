# 本机：模拟时要知道的事实

两台机器是同一套架构，片内固件不是同一份镜像。没有 BIOS，没有第三颗 ROM。上电从片内 Flash 的向量表直接进裸机程序。

## 存储器

CPU 是 STM32H7B0VB，Cortex-M7，小端，Thumb。官方片内 Flash 128 KB。社区在改机时还用到 `0x08100000` 的第二段，原厂菜单不依赖它。

| 区域 | 地址 | 大小 | 模拟器里怎么对待 |
|---|---|---|---|
| ITCM | `0x00000000` | 64 KB | 可执行 RAM。原厂启动后从外挂 Flash 拷进约 1300 字节代码。备份文件是运行时快照，不是要烧写的镜像 |
| 片内 Flash | `0x08000000` | 128 KB | 加载 `internal_flash_backup_*.bin`。向量表在文件开头，复位向量最低位为 1 |
| DTCM | `0x20000000` | 128 KB | 栈在这里。Mario 原厂初始 MSP 见向量表第一个字 |
| AXI SRAM | `0x24000000` | 约 1 MB，分三块 | 帧缓冲和模拟器工作 RAM 的主要去处。分块见 [game_and_watch_fun](https://github.com/WRansohoff/game_and_watch_fun) 的 README |
| AHB SRAM | `0x30000000` | SRAM1/SRAM2 各 64 KB 起 | 按 RM0455 / SVD |
| Backup SRAM | `0x38800000` | 4 KB | 可先做成普通 RAM |
| 外设 | `0x40000000` 起，部分在 `0x50000000`、`0x52000000`、`0x58000000` | | 见 `svd/STM32H7B0.svd`。GPIOA 基址 `0x58020000`，LTDC `0x50001000`，OCTOSPIM `0x5200B400` |
| 外挂 SPI NOR | `0x90000000` | Mario 1 MB（MX25U8035），Zelda 4 MB（MX25U3232） | 加载 `flash_backup_*.bin`。映射后的读要走下面的解密 |

屏是 320×240 RGB 并口，由 LTDC 扫 SRAM 里的 RGB565 帧缓冲，不是 NES 的图块显存，也没有命令式 GPU。社区笔记里的屏型号是群创 `ZJ024NA-17A` 一类。DMA2D（Chrom-ART）只做矩形填充、拷贝和像素格式转换。

## 外挂 Flash 里什么是加密的

解密算法在 `externals/game-and-watch-patch/patches/firmware.py` 的 `crypt()`：AES-CTR，计数器和地址 `0x90000000 + offset` 有关。密钥和 nonce 以明文放在对应的片内镜像里，位置见 `README.md`。文档不记录密钥字节。

| 机型 | 加密区间（文件偏移） | 加密区之外 |
|---|---|---|
| Mario | `0x00000`–`0xFE000` | 最后 8 KB 是存档 |
| Zelda | `0x20000`–`0x3254A0` | 开头 128 KB 是存档槽；尾部大多空白 |

游戏 ROM 在加密区里，没有 `NES\x1a` 文件头。Mario 的《超级马力欧兄弟》在解密后 `0x1E60` 起 40960 字节；《失落关卡》是 `0xAEC58` 处的 FDS 镜像。Zelda 的 NES / FDS / 四份 Game Boy《织梦岛》区间在 `externals/game-and-watch-patch/patches/zelda.py` 和 [game-and-watch-decrypt](https://github.com/GMMan/game-and-watch-decrypt) 的说明里。模拟固件时不要把这些 ROM 抽出来换解释器，让原厂代码自己读 `0x90000000`。

## 第一版要做成能跑的外设

固件逻辑不用重写。下面这些行为不对时，启动会停住，游戏代码不会执行：

1. Cortex-M7：Thumb-2、NVIC、SysTick。复位后 SP 和 PC 来自 `0x08000000`。
2. 片内 Flash 只读即可。写 Flash 可以先忽略。
3. ITCM / DTCM / AXI SRAM 按上表可读写。
4. `0x90000000` 窗口：落在加密区间的读先解密。写先可以只作用于明文存档区。
5. GPIO 输入寄存器反映按键。引脚以 [GnWuCpinmap-port-oriented.png](https://github.com/Upcycle-Electronics/game-and-watch-hardware) 和 [game_and_watch_fun](https://github.com/WRansohoff/game_and_watch_fun) 的开机寄存器快照为准。Mario 与 Zelda 的键数不同。
6. LTDC：层起始地址指向的 RGB565 缓冲，每帧拷出 320×240。时序寄存器（`SSCR`、`BPCR`、`AWCR`、`TWCR`）先读回固件写过的值。
7. RCC、Flash 等待、OTFDEC 区域寄存器：先做成写了能读回。固件若死等某个状态位，再对着 RM0455 补那一位。

声音、休眠和周期精确的 LCD 扫描可以空着。未知外设读回 0、写丢弃，并记一条日志，用来决定下一块要补的寄存器。
