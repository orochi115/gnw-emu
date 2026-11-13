# hwtest：Cortex-M7 时序测试（真机与模拟器）

这里保留历史时序实验及真机测试程序。旧模拟器 runner 已退出维护，本机文件/结果仍保留；复现旧模拟器必须使用[迁移历史快照](../docs/research/2026-11-13-gwemu-migration-history.md)，不能据此推断当前 gwemu 的时序精度。本次迁移跳过实机测试。

用 DWT_CYCCNT 测 CPU 指令、取指、各块内存、DMA2D/DMA/CRYP、中断进出、各时钟的周期数。结果和评估见 `../docs/cycle-accuracy.md`。

## 构建

```sh
make -C hwtest            # build/bench_ram.bin（ITCM）和 build/bench_bank2.bin（0x08138000）
python3 hwtest/mkbank2.py ../game-and-watch-backup/backups/full_YYYYMMDD_HHMM/bank2.bin
                          # build/bank2_with_bench.bin = 备份的 bank2 + 测试程序（只在擦除过的末尾）
```

默认用 Homebrew 的 `arm-none-eabi-gcc`，没有时回退到 `/opt/gcc-arm-none-eabi-10.3-2021.10`；`make PREFIX=...` 可以指定。

## 运行方式

测试程序不经复位启动：调试器先暂停正在运行的固件，在线程模式下设置 `PC = _entry`、`PRIMASK = 1` 后继续运行。所以固件配好的时钟、Flash 等待周期、OSPI 内存映射都原样保留。结果表写在 DTCM 末尾 `0x2001E000`（8 KiB，格式见 `bench.h`），状态字变成 `DONE` 后由调试器读回。

| 环境 | 命令 |
|---|---|
| 历史模拟器（历史快照） | `.venv/bin/python hwtest/emu_run.py --context stock\|retrogo --build ram\|bank2 --out hwtest/results/emu_X.bin` |
| 真机 A（不写 Flash） | `hwtest/hw_remote.sh ram current\|retrogo NAME [RESET]` |
| 真机 B（bank2 里的副本） | 先用 gnwmanager 写入 `bank2_with_bench.bin`，再 `hwtest/hw_remote.sh bank2 current\|retrogo NAME [RESET]`，测完 `python -m gnwmanager restore-backup DIR --only bank2` |
| 解码 / 对比 | `python3 hwtest/parse.py X.bin`、`python3 hwtest/parse.py --compare hw.bin emu.bin` |

`hw_remote.sh` 通过 ssh 在接着 ST-Link 的 Windows 机器上运行 OpenOCD（`run_bench.tcl`）。`current` 表示暂停当前正在运行的固件；`retrogo` 表示复位后从 bank2 启动 Retro-Go，4 秒后再暂停。

注意：
- `RESET=1`（默认）会在结束时复位芯片。原厂固件软件复位后自己进待机，需要按电源键才能再连上。连续测试时用 `RESET=0`：测试程序结束后留在空循环里喂看门狗，下一轮直接暂停重新装载。这时屏幕停在最后一帧，按键没有反应，属于正常现象，复位或拔电池就恢复。
- 原厂和 Retro-Go 都开着窗口看门狗 WWDG，一旦开启就关不掉。测试程序在 `kick()` 里只在计数值低于窗口值时才重装（太早重装也会复位）。OpenOCD 暂停期间靠 DBGMCU 冻结看门狗。

## 内存布局

| 地址 | 用途 |
|---|---|
| `0x00000000–0x00007FFF` | A 阶段的代码（ITCM） |
| `0x00008000–0x0000FFFF` | ITCM 测试缓冲 / 取指副本 |
| `0x08138000–0x0813FFFF` | B 阶段的代码（bank2 末尾，Retro-Go 只用到 `0x35E23`） |
| `0x20000000–0x20007FFF` | .bss |
| `0x20008000–0x20017FFF` | DTCM 测试缓冲 |
| `0x2001E000–0x2001FFFF` | 结果表，栈从 `0x2001E000` 往下 |
| `0x24040000`、`0x240A0000`、`0x240D0000` | DMA2D/DMA 的背景、源、目的缓冲（各 150 KiB） |
| `0x24080000` / `0x24090000` | AXI 测试缓冲 / 取指副本 |
| `0x240F8000` | SRD SRAM 的备份（测试结束前写回） |
| `0x30000000` / `0x30010000` | AHB 测试缓冲 / 取指副本 |
| `0x38000000` / `0x38006000` | SRD 测试缓冲 / 取指副本 |

## 安全约束（代码里遵守）

不写 FLASH 控制寄存器和选项字节；不发 OSPI 命令，只做内存映射读；不改 RCC 时钟树和电压档位，只打开外设时钟门控；不写 RTC 和备份寄存器；SRD SRAM 先备份后写回；CRYP 用自带的测试密钥，快照里不读任何密钥寄存器。

## 文件

| 文件 | 内容 |
|---|---|
| `bench.c`、`startup.S`、`bench.h` | 测试程序、入口与中断向量、结果表格式 |
| `gen_kernels.py` | 生成 `build/kernels.S`（位置无关的计时内核）和 `kernels.h` |
| `tests.def`、`snap.def` | 测试编号、开头快照的寄存器列表（`parse.py` 也读） |
| `run_bench.tcl`、`hw_remote.sh` | 真机运行 |
| `emu_run.py`（历史快照） | 旧模拟器运行（自带最小 GDB RSP 客户端，已退出维护） |
| `mkbank2.py` | 生成 B 阶段的 bank2 镜像 |
| `parse.py` | 解码、换算、对比 |
| `results/` | `hw_{A,B}_{stock,retrogo}_{1,2,3}`：真机三轮；`emu_*`：模拟器对照。`.bin` 原始结果表，`.json` 解码，`.log` OpenOCD 输出 |
