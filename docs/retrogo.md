# Retro-Go：SD 与 Flash 共用源码

当前固件统一来自 `externals/retro-go-sd` 的用户 fork `gnw-emu` 分支，基于 sylverb `external_cores`。`SD_CARD=1` 使用 FAT32 卡；`SD_CARD=0` 使用外置 Flash 的 FrogFS 与 LittleFS。传统 `game-and-watch-retro-go` 源码依赖退役，原固件仍可作为历史 ROM 使用。

## 本地资源库

ROM、封面、BIOS 和金手指不提交公开 Git。一次迁移会复制所有源文件，保留旧压缩缓存、原始图片和说明文件；SHA256 清单记录每个源文件与所有目标。工具拒绝冲突覆盖，重复执行只做一致性核对。

```sh
python3 scripts/migrate_retrogo_assets.py \
  --source ../xx/game-and-watch-retro-go/roms \
  --output local/retrogo-assets
```

`originals/` 保留原样资料，`media/` 是供新固件使用的目录。Game Boy Color 会分到 `media/roms/gbc`；同 stem 的 GB/GBC 游戏使用带原扩展标识的名字，关联封面和金手指同步映射。`manifest.json` 提供完整对应关系。这里的 532 个 ROM 全量迁移不代表所有游戏都可同时放进 64 MiB Flash。

## Flash-only

准备工具链和 Python 环境，以及固定核心 release（见 [SD 文档](sdcard.md)）。独立核心 release 要求原始 ROM 扩展名，此入口使用 `COMPRESS=0`；旧版的 `.lzma` ROM 不适用于这些核心。

```sh
# 独立 Bank 1，使用显式选择清单；output 必须是新目录。
python3 scripts/build_retrogo_flash.py --output out/my-retrogo-flash

# Zelda 原厂 + Bank 2；原厂的前 4 MiB 外置区原样保留。
python3 scripts/build_retrogo_flash.py --output out/my-retrogo-dualboot \
  --bank 2 --extflash-offset 0x400000 \
  --ofw-bank1 ../game-and-watch-backup/backups/full_20261104_1021/bank1.bin \
  --ofw-extflash ../game-and-watch-backup/backups/full_20261104_1021/ext.bin
```

默认 [选择清单](../profiles/retrogo-flash-selection.json) 包含 8 类平台的 9 个游戏（含 GB 与 GBC），可复制清单并用 `--selection` 指定自己的游戏。入口支持 `--assets`、`--source`、`--cores`、`--gcc-path`、`--python-venv`、`--model` 和芯片容量选项。超过只读区、与可写区重叠、文件缺失或输出已存在都会失败，不能通过自动删除游戏解决容量问题。

每次构建复制源码到输出目录隔离编译，保留主子模块的 SD 产物。产物包括内部固件、FF 擦除值填充的整芯片 `extflash.bin`、可直接打开的 `retrogo-flash.gnw.json`，以及来源、输入/输出 SHA256 和布局清单。核心 release 版本从父仓库固定的 `externals/cores` tag 下载；构建清单进一步记录实际核心文件 hash。

SDK 下载补丁保留在用户 fork：`SDK_RAW_BASE=https://raw.gitmirror.com` 可同时改变 SDK/CMSIS/HAL 的来源前缀，下载显示进度；默认仍使用上游 GitHub 原始文件地址。原有 GCC 10 linker 兼容补丁保留。PCE 的旧缩放修补由当前独立核心实现覆盖，无须修改第三方核心仓库。

## SD 全集

```sh
python3 scripts/make_sd_image.py out/my-retrogo-sd/card.img \
  --assets local/retrogo-assets/media --size-mb 512
```

`run_sd.sh` 和 `run_sd_update.sh` 的新镜像默认读取这个统一资源库。`ROMS=...` 仍可显式指定旧式 ROM 目录。已有卡镜像和会话继续使用原数据；要使用新全集，指定新 `SDCARD=...`，或在未指定源卡时使用 `FRESH=1` 重建生成卡。

## 旧数据恢复

新版文件系统、核心和设置结构与旧版不同。旧即时存档不自动转换，尤其 Gnuboy → TGB Dual 的格式不同；既有模拟器快照必须使用其原固件。保留原始备份、旧 profile 和历史 checkout，退役只移除源码构建依赖。

本机已另存 `local/retrogo-assets/legacy/{bank1.bin,bank2.bin,ext.bin}`，附有来源/hash 清单及 `legacy-recovery.gnw.json`。它对应原备份中的旧游戏存档；既有用户会话和即时存档目录没有改写。

实测结果与限制见 [迁移验收报告](research/2026-11-13-retrogo-consolidation.md)。本次仅软件验收，没有刷写实机。
