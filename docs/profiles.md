# 启动文件：ROM profile、会话、全局设置

一次可运行的机器由多份镜像组成（片内 Bank 1、外挂 SPI NOR，改装机还有 Bank 2 和 SD 卡）。这些路径现在拆在 `scripts/run.sh` 的环境变量和 `-M gnw-…` 属性里，SD 卡又单独走 `-drive`。本文把它们收成三个文本文件。格式是 TOML。窗口运行走 `scripts/run.sh`。参数 `zelda` / `mario` 加载 `profiles/zelda.gnw.toml` 和 `profiles/mario.gnw.toml`；其他参数是一份 `.gnw.toml`。宿主选项在 `settings.toml`，第一次窗口运行时生成。`run_backup_emu.sh`、`scripts/run_sd.sh`、`scripts/run_sd_update.sh` 都是先写 profile 再调用它。

三个文件各管一层：

| 文件 | 管什么 | 谁来改 |
|---|---|---|
| ROM profile | 这台机器的固化内容：机型和只读镜像 | 人写，模拟器不回写 |
| 会话 | 这台机器的可变状态：电量、存档文件放哪 | 首次运行生成，退出时回写标量 |
| 全局设置 | 这台宿主上所有机器共用的选项：声音、窗口、节拍 | 首次运行生成，人改 |

加载时只选择 profile。模拟器再按 profile 的绝对路径找到会话；没有会话就按全局设置和内建默认值生成。命令行和环境变量只覆盖这一次运行，不写回 profile。电量这类运行中会变的量，仍在退出时写入会话。

查找顺序：命令行 / 环境变量，然后会话，然后全局设置，最后是下面各节的内建默认值。profile 里的镜像路径不参与这层覆盖。

## ROM profile

扩展名 `.gnw.toml`。路径一律相对 profile 文件所在目录，加载时先换成绝对路径再交给 QEMU。机器类型必须写明，模拟器不从文件名推断板型。

| 字段 | 必须 | 含义 | 对应现有参数 |
|---|---|---|---|
| `version` | 是 | 文件版本，目前为 `1` | — |
| `model` | 是 | `zelda` 或 `mario` | `-M gnw-$MODEL` |
| `internal` | 是 | 片内 Flash Bank 1，128 或 256 KiB，映射到 `0x08000000` | `internal=` |
| `external` | 是 | 外挂 SPI NOR，1 或 4 MiB，经 OCTOSPI1 / OTFDEC 映射到 `0x90000000` | `external=` |
| `bank2` | 否 | 片内 Bank 2，最多 256 KiB，映射到 `0x08100000`。不写时读出全 `0xFF` | `bank2=` |
| `sdcard` | 否 | microSD 原始镜像（MBR + FAT/exFAT） | `-drive if=sd,format=raw` |
| `sd-wiring` | 否 | `spi1`（默认）或 `ospi`。只在写了 `sdcard` 时有效 | `sd-wiring=` |
| `uid` | 否 | 96 位器件 UID，24 位十六进制。Retro-Go 用它给外挂 Flash 缓存做索引。不写时用模拟器内建 UID | `uid=` |

原厂双镜像：

```toml
version = 1
model = "zelda"
internal = "internal_flash_backup_zelda.bin"
external = "flash_backup_zelda.bin"
```

`game-and-watch-backup` 做出的双系统备份可以和镜像放在同一目录。profile 只引用它们，模拟器不修改这些文件。

```toml
version = 1
model = "zelda"
internal = "bank1.bin"
external = "ext.bin"
bank2 = "bank2.bin"
```

Retro-Go SD 再加卡镜像和接线：

```toml
version = 1
model = "zelda"
internal = "bank1.bin"
external = "ext.bin"
bank2 = "bank2.bin"
sdcard = "sdcard.img"
sd-wiring = "spi1"
uid = "00112233445566778899aabb"
```

profile 里不写电量、RTC、音频、窗口，也不写 `overlay`、`bank1-overlay`、`bank2-overlay`。后三个文件会被固件改写，属于会话。

## 会话

每份 profile 一份会话，按 profile 的绝对路径区分。目录是：

```text
gnw-emu/out/sessions/<profile 主文件名>-<路径哈希前 8 位十六进制>/
```

主文件名去掉 `.gnw.toml`。哈希用来区分不同目录下的同名 profile，避免两台备份共用存档。目录里是：

| 文件 | 内容 |
|---|---|
| `session.toml` | 下面的标量，以及三个存档文件的路径 |
| `flash.bin` | 外挂 SPI NOR 的可写副本。缺文件时从 profile 的 `external` 复制 |
| `bank1.bin` | Bank 1 编程落盘。缺文件时从 `internal` 复制 |
| `bank2.bin` | Bank 2 编程落盘。profile 写了 `bank2` 时，缺文件就从它复制；没写 `bank2` 时不建这个文件 |

这三个二进制文件就是存档本体，对应现在的 `overlay=`、`bank1-overlay=`、`bank2-overlay=`。`session.toml` 只记录它们的路径和运行选项，不把 Flash 内容嵌进去。

`session.toml` 的字段：

| 字段 | 内建默认 | 含义 | 对应现有参数 |
|---|---|---|---|
| `version` | `1` | 文件版本 | — |
| `battery` | `100` | 电量百分比，0–100。退出时写成当时的值 | `battery=` |
| `usb-power` | `false` | 是否插着 USB。退出时写回 | `usb-power=` |
| `battery-life-min` | `480` | 电池从 100% 放到 0% 的分钟数。`0` 表示电量保持不变 | `battery-life-min=` |
| `charge-time-min` | `180` | USB 供电时从 0% 充到 100% 的分钟数。`0` 表示不涨 | `charge-time-min=` |
| `rtc` | `"host"` | `"host"` 用本机时间；或写成 `2026-01-01T09:00:00` 这样的固定起点 | `-rtc` |
| `overlay` | 本目录的 `flash.bin` | 外挂 Flash 可写副本 | `overlay=` |
| `bank1-overlay` | 本目录的 `bank1.bin` | Bank 1 编程落盘 | `bank1-overlay=` |
| `bank2-overlay` | 本目录的 `bank2.bin`，或空 | Bank 2 编程落盘。profile 没有 `bank2` 时留空 | `bank2-overlay=` |

`overlay`、`bank1-overlay`、`bank2-overlay` 相对会话目录解析。把它们改到别处，存档就离开 `out/sessions/`。profile 所在目录保持只读，因此可以把 `.gnw.toml` 直接放进备份目录。

首次打开某份 profile 时创建会话目录和 `session.toml`，并按上表准备尚不存在的 overlay。之后每次退出更新 `battery` 和 `usb-power`。删除整个会话目录即从这份 profile 的初始镜像重新开始；profile 和备份都还在。

音频、窗口和实时节拍不进会话。两台机器应共用宿主上的同一套偏好。

## 全局设置

路径固定为 `gnw-emu/settings.toml`。文件不存在时按内建默认值运行，并在第一次窗口运行时写出这份文件。测试和 headless 只读它，不因为缺文件而创建。

| 字段 | 内建默认 | 含义 | 对应现有参数 |
|---|---|---|---|
| `version` | `1` | 文件版本 | — |
| `audio` | `true` | 用宿主播放 SAI1。headless 仍可用单独的 `wav=` 录音，那是调试输出，不进这个文件 | `audio=` |
| `display` | `"cocoa,zoom-to-fit=on"` | QEMU 显示后端。无窗口运行为 `"none"` | `-display` |
| `realtime` | `true` | 与 `-icount shift=2,sleep=off` 一起使用：定时器按指令数触发，虚拟时间对齐宿主时钟 | `realtime=on` |

按键、电量曲线和板级差异不放在这里。按键仍是现在的键盘映射；板级差异由 profile 的 `model` 决定。

示例：

```toml
version = 1
audio = true
display = "cocoa,zoom-to-fit=on"
realtime = true
```

## 一次启动怎么拼

以「备份目录里的 `zelda.gnw.toml`」为例。`scripts/run.sh` 做这些事，QEMU 机器属性仍只接收已经展开的绝对路径：

1. 读 `gnw-emu/settings.toml`，缺了就用内建默认。
2. 读 profile，把 `internal`、`external`、`bank2`、`sdcard` 解成绝对路径。
3. 用 profile 绝对路径算出 `out/sessions/zelda-<哈希>/`。没有 `session.toml` 就生成，并备好 overlay。
4. 拼出现在的命令行：`-M gnw-<model>,internal=…,external=…,overlay=…`，有 SD 卡时加 `-drive if=sd,format=raw,file=…`，RTC 和显示后端来自会话与全局设置。
5. 退出时把当时的电量和 USB 状态写回 `session.toml`。机器属性 `state-file` 指向会话目录里的 `state.txt`，QEMU 退出时写下这两项；启动器读完后删掉 `state.txt`。overlay 文件在运行期间已经由机器模型落盘。

命令行上的一次性覆盖（例如这次用 `battery=30`）加在第 4 步，优先级高于会话和全局设置，并且不写回 `session.toml`，除非这个量本来就会在退出时保存。
