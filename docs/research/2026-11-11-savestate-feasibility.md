# gnw-emu 即时存档技术评估

日期：2026-11-11。本文件记录实现前的技术评估及方案讨论，实验结果对应补齐 VMState 之前的版本。

最终实现采用完整保存所有 flash、读取覆盖当前 session、挂载 SD 时拒绝、外部 flash 上限 64 MiB 的路线；早期工作分支、RAM-only 校验和 SD 差分建议均未采用。产品行为以 [即时存档说明](../desktop/savestates.md) 为准。

后续用户约束：完整读档必须回滚当前 session 的介质，拒绝工作分支方案；下文原先的独立工作分支推荐已撤回。大容量 SD 应进一步评估块级差分快照，见文末补充。

## 结论

技术可行，但不能只添加一个桌面 `savevm` 按钮。QEMU 已有 CPU、RAM、NVIC、SysTick 和虚拟时间的保存基础；gnw-emu 自定义的机器状态及外设需要补齐 VMState。主要工作是状态覆盖、一致性和错误恢复，不是重新实现 CPU 快照。

完整即时存档应逻辑上包含两块内置 flash bank、外置 NOR flash；使用 SD 的配置还必须包含 SD 内容的同一时刻版本。这里的“包含”可以是独立镜像，也可以是不可变基线加差分，不要求每个槽位都复制整个介质。

推荐两种模式：默认“完整状态”，恢复到独立的可写工作分支以保留当前本地存档；可选“仅运行状态”，不保存或恢复介质内容，但默认只允许介质与存档时完全一致时读档。两者都必须包含 CPU、RAM、外设和虚拟时间。单独导出/写回 RAM 属于调试功能，不能提供可靠续玩语义。

## 1. 当前代码与实测结果

实验在临时目录启动两个 headless QEMU 实例，无 session overlay，未写入实际 session 或原始固件。运行 Zelda 原厂固件 200 ms 虚拟时间，在暂停后做文件迁移，再向新进程恢复。

原始结果见 [probe JSON](2026-11-11-savestate-probe.json)，实验脚本见 [probe Python](2026-11-11-savestate-probe.py)。

| 检查 | 实际结果 | 含义 |
| --- | --- | --- |
| HMP `savevm feasibility` | `no block device can store vmstate for snapshot` | 当前启动配置不能直接使用块设备内部快照 |
| QMP `migrate`，`file:` 目标 | completed，文件 4,666,692 字节 | 文件形式保存通道可用 |
| 恢复到新 QEMU | paused，PC 同为 `0x080189f8` | CPU 恢复有效 |
| 全部 128 KiB DTCM SHA-256 | 恢复前后相同；源内含 2,621 个非零字节 | 已验证真实 RAM 数据恢复 |
| OCTOSPI CR | `0x30400301` → `0` | 自定义外设状态缺失 |
| LTDC GCR | `0x10000001` → `0` | 显示控制器状态缺失 |
| DAC1 CR | `0x00010001` → `0` | DAC 状态缺失 |
| RCC CR | `0x3f00c1a5` → `0x0000c025` | 通用寄存器外设状态缺失 |

迁移流列出的设备状态只有 timer、cpu_common、cpu、armv7m_nvic、armv7m_systick、armv7m 和 globalstate；没有 gnw 自定义外设。QMP 报告 completed 只说明已经注册的状态成功传输，不能证明整台机器完整恢复。

该单次实验保存阶段观察到约 31 ms，包括轮询等待。它不是完整即时存档的性能基准：没有补齐外设、SD 镜像、介质提交和解密重建，也没有验证恢复后游戏正常运行。

### 需要保存的状态

- CPU、NVIC、SysTick、六个 RAM 区域，以及虚拟时钟。板级 RAM 共 1,412 KiB，约 1.38 MiB。
- GPIO/EXTI/SYSCFG、通用寄存器设备（包括 RCC/PWR 等）、定时器/RTC/TAMP、DMA/DMAMUX/SAI、LTDC/DMA2D、DAC、ADC。
- CRYP 的输入输出 FIFO、GCM 中间状态；JPEG 的输入、解析进度、输出与读取游标。
- FLASH 的解锁步骤、未凑齐 16 字节的编程缓冲；OCTOSPI/OTFDEC 寄存器、密钥、FIFO、待写缓冲、NOR 状态寄存器。
- SPI/SD 的命令、部分扇区、读写游标及 bitbang 状态；板级 DWT、SCR、电量及电量定时器等。

不能直接序列化宿主指针、文件描述符、QEMU 对象、声音后端或 socket。它们由新进程重建。读档后需要更新 IRQ、内存映射视图、翻译代码缓存，并清理旧宿主音频/画面。当前手柄/键盘输入及音量、窗口等宿主设置应由前端重新应用，避免恢复已经松开的按键。RTC 若使用宿主时钟，需要明确它继续对齐现实时间，不能宣称严格回到旧时刻；虚拟时钟模式则应恢复存档时间。

### 一个容易误判的细节

QEMU 的 `memory_region_init_rom` 和 `memory_region_init_rom_device` 也会注册可迁移 RAMBlock。当前迁移因此会包括内置 flash bank 和外置 flash 的 `ospi-xip` 解密视图；它不会自动包括通过 `g_malloc` 分配的外置原始 flash。

外置 flash 原始内容供 NOR 命令读写，XIP 视图供 CPU 读取和执行。仅恢复 XIP 会造成两条访问路径看到不同内容；内置 bank 恢复到内存也不会自动触发原有 `pwrite` 回写。这些问题要求显式定义介质保存边界，不能靠默认 RAM 迁移规则。

建议把 flash 与可重建的 XIP 视图从通用 RAM 迁移中排除，介质内容由独立快照层管理；根据介质与已恢复的 OTFDEC 密钥重建 XIP，并处理代码缓存失效。静态 UID 可由匹配的机器配置重建。

## 2. Retro-Go 是否把 flash 当作 RAM

不能说 flash 是普通 RAM：固件仍然通过擦除/编程写入，不能像 SRAM 一样任意原地赋值。但“flash 只保存持久化进度，运行时可以忽略”的假设不成立。

当前 `externals/retro-go-sd/Core/Src/gw_flash_alloc.c` 的分配器把 ROM 文件、派生数据和重定位后的代码写入外置 flash，返回 memory-mapped 指针。对应头文件明确提供 streaming blob 接口，让较大的解压结果不必完整放在 RAM。RAM 里的指针、执行地址和缓存元数据依赖当时的 flash 内容。

缓存索引位于 SD 的 `saves/flashcachedata.bin`，记录 flash 地址和长度。源文件开头还专门说明：切换固件后即使旧索引仍通过校验，其对应 flash 地址也可能已被另一固件覆盖。因此只恢复 flash 而保留较新的 SD，同样不保证一致。

`external/firmware_update/Core/Src/gw_intflash.c` 可擦写内置 bank 1/2。固件更新后，旧 RAM/PC/VTOR 和新的内置代码不匹配，内置 flash 也不能一概视为永不改变的启动资源。

传统 `game-and-watch-retro-go/Core/Src/porting/nes_fceu/nes_memory_stream.c` 用 256 字节 RAM 缓冲把存档流逐段写到外置 flash。若恰好在写入过程中做仅运行状态存档，后来恢复旧缓冲/游标，却保留较新的 flash，可能写出混合版本的数据。LittleFS/FAT 等文件系统的 RAM 元数据、打开文件及缓存也有同类问题。

本次源码调查证明了运行时依赖和写入用途，没有发现据此足以宣称所有 Retro-Go 分支都把 NOR 用作通用可写 RAM 或交换内存的证据。

## 3. 三种方案比较

| 方案 | 恢复一致性 | 对当前本地存档的影响 | 空间/实现代价 |
| --- | --- | --- | --- |
| 完整快照，直接回滚工作介质 | 补齐状态后可保证 | 会回滚游戏进度、设置、缓存和固件；SD 也会回滚 | 最易实现；可在恢复前保留完整备份 |
| 完整快照，恢复到独立工作分支（推荐） | 补齐状态后可保证 | 旧分支保留，后续写入在新分支；原始槽位保持不可变 | 需要 session 管理活动分支；可通过 COW/差分降低空间 |
| 仅运行状态，沿用当前介质 | 仅在依赖内容一致时可靠 | 读档步骤不主动回滚 flash/SD；恢复后的固件仍可能自行写入 | 存档小，但兼容性受限；应保存介质哈希并默认拒绝不匹配 |

完整快照的“覆盖本地 flash”不是必然代价，而是恢复目的地的设计选择。独立工作分支可以同时满足完整恢复和保留当前存档。但它不会自动把两个时间线的游戏进度合并；用户若想把分支设为后续常用进度，需要有明确的活动分支语义。

仅运行状态的严格检查建议涵盖两个 bank、外置 flash，以及存在时的 SD 镜像。内容相同但路径不同应允许；内容不同则默认拒绝。这样可能连无关区域变化也拒绝，但对任意固件更可靠。高级“强制恢复”若以后提供，应明确属于可能不一致的调试操作。

仅运行状态读档不写介质，也不代表后续运行不会改变游戏存档：恢复的旧固件状态仍可再次执行保存操作。

不建议第一版只回滚猜测为“临时缓存”的 flash 区域，保留猜测为“持久化存档”的区域。任意固件的布局、分配器、文件系统元数据和更新路径并不统一，不能在硬件层普遍推断出可靠的分界。

## 4. 时间与空间

运行状态基础 RAM 约 1.38 MiB，加 CPU/设备数据；JPEG 等动态缓冲在工作时会让它变大。原厂 Mario 外置 flash 为 1 MiB，Zelda 为 4 MiB，常见改装为 64 MiB；另加约 384–512 KiB 内置 bank。带 SD 时，SD 镜像通常才是最大部分。

可以分离不可变介质数据与运行状态，使用压缩、块去重、基线加差分；不保存可重建 XIP，避免重复保存原始/解密内容。已压缩 ROM 不一定能显著再压缩。块哈希和重建本身也有成本，不能把“差分”直接等同于低延迟。

可先实现独立完整快照，确保正确性，再做不可变基线和块去重。若借助 APFS clonefile / Linux reflink 创建可写分支，应验证平台行为；普通硬链接不可用，写入会影响同一底层文件。跨平台不支持 COW 时需要复制，尤其 SD 的创建/恢复时间必须单独测量。

## 5. 建议的后续实施边界

存档全部保存在 `session.directory` 下。建议手动槽位 0–9，加独立自动槽；记录缩略图、时间、模式、固件/机器版本和介质版本。快速保存/读取使用当前槽位，切换槽位有明确反馈。自动保存应避开手动槽。

概念目录：

```text
sessions/<profile-id>/
  session.json
  states/
    slots/0/manifest.json
    slots/0/runtime.bin
    slots/0/preview.png
    media/<immutable-version>/...
  branches/<branch-id>/
    bank1.bin
    bank2.bin
    flash.bin
    sdcard.img
```

现有 session 的根目录工作镜像可作为初始分支迁移，避免一开始就改变旧配置。仅运行状态槽位没有介质 payload，但保留内容校验信息。

保存流程：暂停 CPU，等待块 I/O 排空，截取介质和运行状态的同一时刻；用临时版本写入并验证，最后原子更新槽位引用，失败保留旧槽位，再恢复原有运行/暂停状态。

恢复流程：先校验格式、QEMU/设备状态版本、机型、UID、介质尺寸及内容；准备独立工作分支，然后用新 QEMU 进程加载状态，再连接输入/显示/声音。正常输入端点、文件描述符和锁重新建立。读档失败不能覆盖原分支或自动提交坏分支，前端需要保留可恢复的原运行状态/工作分支。

可先复用 `migrate` 到文件、`-incoming defer` 加 `migrate-incoming`，降低对 QEMU 通用代码的改动。现有 `migrate-incoming` 是一次性初始化接口，不能当成同一进程反复读槽的命令；新进程恢复符合其语义。也可后续提供专用 QMP 保存/恢复命令复用内部 VMState，但需要承担错误恢复和状态回调处理。

最低验证范围：原厂 Mario/Zelda、Retro-Go flash 版及 SD 版；连续保存恢复、跨进程恢复、正在编程 flash/读取 SD/处理 DMA 时恢复；外置原始内容与 XIP 一致；完整恢复后的 frame/guest RAM/介质可重复；旧分支仍保留；仅运行状态在内容相同可读、不同拒绝；损坏文件和取消操作不会破坏旧槽位。保存/恢复的真实延迟和空间在这些状态补齐后测量。

本报告完成可行性评估，不代表即时存档功能已经实现，或恢复后的游戏行为已经通过验证。

## 补充：大容量 SD 与不恢复 SD 的影响

恢复旧 RAM/flash 而保留较新 SD，仅在相关 SD 内容未变化时可可靠续玩；无法普遍保证当前 Retro-Go SD 兼容。

- gw_flash_alloc.c:256 的 load_metadata 校验索引大小、版本、UID 和 flash 基址，但不校验整个 flash 内容。SD 上较新的 flashcachedata.bin 可通过结构校验，却描述已被读档回滚的 flash 内容。旧 RAM 的 metadata 与新 SD 索引也可能在本次运行/下次重启时产生不同行为。
- odroid_system.c:333–438 将核心存档、截图、槽位信息写入 SD；odroid_settings.c 还保存设置和作弊配置。它们不随 RAM/flash 读档回退；后续运行可能用旧内存再次覆盖新 SD 文件。
- FatFs/ff.h 中 FATFS 保存目录/FAT sector window、dirty flag、空闲簇信息；FIL 保存文件长度、位置、当前簇/扇区、目录位置和可选数据缓存。恢复旧 RAM 可恢复旧文件系统缓存及事务状态，不能靠宿主 block flush 消除。如果期间目录/FAT 已改变，旧缓存之后写回可能破坏文件或分配结构；只是没有当前 SD I/O，并不意味着缓存一致。
- pce-go-retro-go-sd/src/porting/pce_cd.c:235 起保留 CD 数据/音频的文件句柄，运行时通过 fseek/fread 流式读卡。只读资源保持相同且其簇链未变时可继续读取；不能假定所有游戏都已全部缓存在 RAM/flash。

最直接的解决方向是 session 的 SD 使用可快照块后端（例如只读 raw 基线 + qcow2 可写 overlay），保存/恢复 SD 的块映射版本，并与 RAM/flash 同步。这是同一虚拟 SD 卡的直接时间回滚，不是用户可见的运行分支。512 GB 虚拟容量不要求每槽复制 512 GB；成本取决于改写过的块及保留版本，最坏仍可能很大。

当前代码不能直接获得该行为：prepareSession 用普通 copyFile 复制 raw 卡，qemu-command.ts 固定 format=raw。不过 gnw_sdcard.c 已通过 BlockBackend 的 blk_pread/blk_pwrite 访问扇区，可复用 QEMU qcow2 功能，无须修改 Retro-Go 来识别 qcow2。源基线必须保持不可变、可访问，否则依赖它的所有差分快照都可能失效；创建 session 不应继续无条件做完整 raw 复制。若要求所有依赖都在 session 内，可评估受支持的 reflink/clone 导入及普通复制回退。

以上影响来自源码分析，未进行实际破坏 SD 文件系统的恢复实验，也尚未实现和验证 qcow2 方案。
