# Retro-Go SD external_cores：Flash-only 替代评估与迁移方案

## 结论

`retro-go-sd/external_cores` 可以作为新的 Flash-only 固件源码，统一维护 `SD_CARD=0/1`；不能作为旧 `rabbit-gnw` 镜像、设置或全部存档的直接替换。用户确认推荐路线后，迁移与旧源码依赖退役已完成：8 类平台及 GBC 代表游戏无卡加载、NES 保存/读取/重启恢复、Bank 2 双启动与完整库 SD 启动通过软件验证。

当前 64 MiB Flash 不能装入工作区当前 ROM 全集。建议先迁移完整本地资源库，再为 Flash-only 显式选择可装入的游戏集；完整库用于 SD 模式。退役旧源码依赖时保留旧固件、备份和现有模拟器 profile，避免丢失旧存档的读取环境。

## 固定版本与 fork

- 父仓库：`orochi115/gnw-emu`，`master`。
- 新子模块初始：`orochi115/game-and-watch-retro-go-sd`，`gnw-emu/a84fa44c6d9c07752dca37f3718ab951b6db5965`；最终 `bc092942d819aee43ed902fcf10edcf0c7829f62` 已公开发布并核对远端。
- 2026-11-13 远端核对：`sylverb/...-sd external_cores` 为 `1b025902cb33607a1a98f42717440b690a7b4ce4`。新子模块在其上只有一条 GNU ld 参数兼容提交。
- 旧子模块：`orochi115/game-and-watch-retro-go`，`rabbit-gnw/8efbaab1e23f9c663635d7af0b6f06f1141680ab`。
- 两个固件仓库已是用户的 fork。第三方核心当前只读使用；如须修改，先 fork 再改依赖。

## 能力与数据差异

| 项目 | 旧 rabbit-gnw | 新 external_cores / SD_CARD=0 | 迁移影响 |
|---|---|---|---|
| 核心 | 静态编译/overlay | 独立 CORE 包动态发现 | 核心版本及 ABI 须固定 |
| ROM/字体/封面/BIOS | 链接进外置 Flash | FrogFS 只读文件系统 | 重新构建，不能复制旧外置镜像 |
| 核心/语言/存档/设置 | 固定地址和旧结构 | LittleFS，可写，镜像块反序 | 新布局和新文件路径 |
| GB | Gnuboy | 现有 release 是 TGB Dual | 旧即时存档不能默认兼容 |
| NES 压缩阈值 | 0x81000 | 0x60010 | 部分 ROM 占用会增加，不能盲抄常量 |
| NES 金手指 | ROM 生成信息 | `/cheats/<system>/...ggcodes` | 文件必须从 ROM 目录重新分流 |
| 封面 | ROM 旁的 `.img` | `/covers/<system>/...img` | 搬到资源路径；保留原始图片 |
| 无 SD 构建 | 传统 all | all + FrogFS + LittleFS | 现有 build_retrogo_sd.sh 的 release 会明确拒绝 SD_CARD=0 |
| 双启动 | 旧 bootloader/metadata | Bank 2 与 OFW 地址配置 | 留出 OFW 的外置区，不能覆盖头部 |

现有 10 个 release 核心的 CORE 元数据覆盖 `gb/gbc, nes, sms/gg/sg/col, gw, md, pce/sgx/pcecd, a7800, msx, amstrad, wsv`。当前非空 ROM 目录有 8 类，均有对应核心。覆盖关系不等于每个游戏均已运行验证。

## 实际数据盘点

旧子模块 ROM 目录约 940 KiB，主要是 MSX 数据库和占位目录，没有用户 ROM；工作区 `xx/game-and-watch-retro-go/roms` 约 436 MiB，是实际资源来源。它包含 532 个原始 ROM，旧生成的 config.h 同样标记 532；生成文件和旧 binary 已存在时间差，因此不能把它们当成当前全集的可重建证明。

`gb/daligongtou1.gb` 与 `gb/daligongtou1.gbc` 同 stem。新打包器生成 `daligongtou1.lzma` 时存在覆盖风险；迁移必须给其目标名添加原扩展标识，并记录源/目标/hash 映射。保留两份源文件，禁止静默覆盖。

直接用旧 SD staging helper 会把 `.keep` 当 ROM 计数，还会把 `.ggcodes` 放到 `/cheats`，而默认 FrogFS include 没有 cheats。迁移不能照搬该 helper 的计数或默认 include。

## 隔离实验与边界

所有试验均在 `out/retrogo-consolidation/`，未改子模块、原 ROM、原备份或实机。

1. 从新子模块复制源码及既有 SDK，使用 GCC 10.3.1、已有 `.venv-rgsd`。
2. `SD_CARD=0 GNW_TARGET=zelda INTFLASH_BANK=1 EXTFLASH_SIZE_MB=64 COVERFLOW=1 COMPRESS=lzma all littlefs_image`，每种当前平台挑一个 ROM，既有 release 核心提供外置包。
3. 编译 exit 0：内部固件 **235188 bytes**，FrogFS **2364024 bytes**，LittleFS **6709248 bytes**。
4. 手工以 FF 擦除值构建 64 MiB 试验镜像，将 FrogFS 放在 0、LittleFS 放在尾部。固定仓库的 gwemu TCG 无 SD drive 启动，菜单截图 `run/boot.png`；用实际 A 键映射 `x` 进入 `Game & Watch Ball`，截图 `run/launched.png`，可见正在运行的游戏。
5. 对当前全集原始 ROM、旧 `.img` 封面进行一次完整 LZMA FrogFS 打包：输出 **175127000 bytes (167.01 MiB)**，超出可用只读区 **60399616 bytes**，命令如期 exit 1。存在同 stem 覆盖，此数字不能作为无损迁移后的最终容量，但足以证明这条打包路径无法装入 64 MiB。

证据：`build.log`、`full-pack.log`、`rom-inventory.json`、`staged-counts.json`、`run/*.png`。尚未证明跨核心旧存档转换、所有游戏、双启动、写存档或实机行为。

## 三种路线

1. **推荐：源码统一，数据分层。** 完整库迁到仓库外/ignored 的统一资源目录；SD 模式使用完整库，64 MiB Flash 模式使用明确选择清单。保留旧固件作为历史数据恢复入口，退役其源码子模块。优点是保留数据且不改变现有硬件容量。
2. **只切 SD 模式。** 完整库可容纳，最少容量限制；不满足本次要求的 SD_CARD=0 独立路线。
3. **扩大 Flash 配置后统一装入。** 须选择新的芯片容量，并验证固件/模拟器/manager一致支持；现有 64 MiB 实机不会因软件设置而扩容，不能默认替用户选择此路线。

## 推荐实施方案（用户已确认并实施）

- 将 ROM、原始封面、生成封面、BIOS、金手指统一为本地资源库；数据不提交公开 Git。按 SHA256 记录源到目标映射，迁移采用复制与校验，原目录保留。
- 处理 GB 同 stem，忽略占位和重复压缩缓存。BIOS 按新核心规范配置，旧 XML/说明作为原始资料保留。
- 在已存在的用户 SD fork 迁入 SDK 镜像下载配置（覆盖 SDK/CMSIS/HAL URL，默认保持上游来源，通过变量选择镜像），保留已有 ld 兼容修补。已被重构取代的旧模块 URL 修改不机械迁入；PCE 缩放修补比较新核心实现后决定，若需要改核心先 fork。
- 增加独立 Flash-only 构建与打包入口，固定新子模块及 release 核心。检查只读区/可写区重叠与容量；不足时报错，禁止自动删游戏或覆盖原镜像。双启动显式保留 OFW 前部区。
- 资源库迁移是全量；64 MiB Flash profile 由平台/游戏清单选择内容，保留新 SD 模式完整库入口。不可把小样本固件称为全量迁移。
- 旧设置不二进制导入。旧即时存档保留完整备份；同核心且版本/格式明确兼容者单独验证导入，Gnuboy → TGB Dual 不承诺转换。现有模拟器快照继续依赖其原固件，不应用到新固件。
- 验收：新 flash-only 无卡启动、至少当前 8 类平台代表游戏、保存/载入/重开、Bank 2 双启动、原 SD 路径直接回归、迁移 hash/数量校验。实机验证另行进行，不写设备。
- 达到验收后删除父仓库旧源码 gitlink/.gitmodules 条目及当前构建文档依赖；历史证据引用可保留并注明 retired。不删除历史 clone、ROM、旧固件或备份，不自动 archive GitHub 仓库。

失败时保持旧依赖，不能先退役再验证。

## 最终结果与验收（2026-11-13）

**资源迁移：** `local/retrogo-assets`（Git ignored）保留 2045 个原始文件、532 个 ROM。独立复核全部源文件和 3170 个映射目标 SHA256。GB 72 个，GBC 66 个；GBC 移到新核心要求的 `/roms/gbc`，关联封面和金手指同步分流。原库、迁移前修正副本、旧 firmware backup 与既有 UserData 均保留。

**压缩限制：** 最初 LZMA 构建只能显示 GW/PCE，另外六类平台的固定 release 核心元数据不接受 `.lzma` 扩展。最终入口使用 **COMPRESS=0** 和原始 ROM，无需修改第三方核心。当前全集原始 ROM 共 **344560214 bytes (328.60 MiB)**，532 个游戏用于 512 MiB SD；Flash-only 采用显式选集。早期 167 MiB 的实验结果仅是被拒绝的压缩路线，不能作为可用 release 的容量承诺。

**代码与补丁：** 已有用户 fork 保留 GCC 10 linker 修补，迁入可配置 `SDK_RAW_BASE` 与下载进度；SDK/CMSIS/HAL 同步覆盖镜像前缀。`/cheats` 放入 LittleFS，因为固件 syscalls 对此路径读取可写文件系统。PCE 新核心已有安全的缩放索引实现；旧 overlay/核心 URL 补丁由独立 CORE 架构取代，不复制失效代码。没有修改第三方仓库。

**构建入口：** `scripts/build_retrogo_flash.py` 隔离构建，固定输入选择，校验 OFW 前缀、分区边界与 FF 空白区；`scripts/fetch_cores.sh` 按已固定子模块 tag 下载。最终新固件来源为干净的 `bc092942`。`out/retrogo-flash-final` 内部固件 **238196 bytes**，整芯片 **67108864 bytes**；默认选择清单为 8 类平台的 9 个游戏，含 GB/GBC。

**软件验证：**

- 17 个资源保全、路径/重名、Flash 容量/覆盖保护、OFW 前缀和真实 LittleFS 金手指读取测试通过；shell 语法与 diff 检查通过。
- 无 SD drive 的原生 gwemu TCG 加载 NES Battle City、MD Aladdin、GW Ball、PCE 1943、A7800 Asteroids、SMS Alex Kidd、GG Streets of Rage 2、GB Super Mario Land；另补验 GBC Mario Tennis。截图分别为实际关卡或游戏标题，没有把菜单截图当游戏加载成功。
- NES 快捷保存/载入、关闭后再打开恢复成功；独立 LittleFS 读取 `/data/nes/tankedazhan.nes-0.sav` **13767 bytes**，SHA256 `6fb2a742ad614eb7ad80821153d1ec30b64faf9c67c0691a7e40d023375119a4`。
- 以原始 bank1、外置前 4 MiB 和新 bank2 组成双启动镜像，原厂进入 Retro-Go，VTOR=`0x08100000`。
- 修正后的 SD 卡 `/roms/gbc` 有 66 个 GBC，全集 532-ROM 的 FAT32 镜像启动到游戏列表；这不是 532 个游戏全部玩法/音频/存档验收。
- 全部操作使用生成镜像或隔离副本，没有刷写实机；实机、全部游戏、全部平台存档转换未验证。旧即时存档继续使用其原固件，新固件不自动导入。

**退役：** 父仓库移除 `externals/game-and-watch-retro-go` gitlink 和 `.gitmodules` 项，忽略并保留本机历史 checkout。当前构建/文档依赖指向新源码和资源库，历史报告中的旧引用保留。远端旧仓库未 archive，父仓库未 push。

**本机可打开的结果：**

- `out/retrogo-flash-final/retrogo-flash.gnw.json`：无卡，9 游戏选集。
- `out/retrogo-flash-dualboot/retrogo-flash.gnw.json`：无卡，原厂 + Bank 2，8 游戏选集。
- `out/retrogo-sd/retrogo-sd.gnw.json`：完整 532-ROM SD 库。
- `local/retrogo-assets/legacy/legacy-recovery.gnw.json`：旧备份固件/存档恢复环境。

**证据目录：** `out/retrogo-consolidation/` 的 `assets-final-verification.json`、`runtime/results.json`、`runtime/games.png`、`runtime-gbc/`、`save-runtime/save-verification.json`、`boot-results.json`、`sd-corrected-boot-results.json`、构建日志与各产物的 `build-manifest.json`。
