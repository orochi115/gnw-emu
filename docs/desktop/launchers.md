# 一键启动固件

以下命令从仓库根目录运行。先按[构建指南](../development.md)准备 Node.js 24+ 和本机 gwemu 构建依赖；固件、备份和 SD 镜像需自行准备。

## 原厂固件与已有配置

```sh
scripts/run.sh                         # 打开应用，使用“制作 ROM…”选择自己的镜像
scripts/run.sh /path/to/device.gnw.json # 打开已有配置
```

`/path/to/...` 为示例路径，请替换成实际文件。`scripts/run.sh mario` 和 `scripts/run.sh zelda` 使用仓库自带的配置，要求先准备其引用的固件；配置中的镜像路径相对于配置文件所在目录解析。详情见[使用指南](../user-guide.md#firmware-images)。

## 完整备份

```sh
scripts/run_backup.sh /path/to/backup
scripts/run_backup.sh /path/to/backup --language=en --debug
```

备份目录必须包含 `bank1.bin`、`bank2.bin` 和 `ext.bin`。此入口生成 Zelda 配置；其他机型请通过“制作 ROM…”明确选择机型。建议始终显式指定备份目录，也可设置 `GNW_BACKUP_DIR`。

入口透传 Electron 参数，例如 `--language=en`、`--automation` 和 `--user-data-dir=/path/to/user-data`。

## Retro-Go SD

以下辅助入口面向 Zelda 双启动固件。首次准备固件、核心和卡镜像的依赖见 [SD 文档](../sdcard.md)。已有自定义镜像也可直接通过“制作 ROM…”组合为配置。

```sh
SDCARD=/path/to/card.img scripts/run_sd.sh /path/to/backup
SD_WIRING=ospi SDCARD=/path/to/card.img scripts/run_sd.sh /path/to/backup
```

备份至少包含 `bank1.bin` 和 `ext.bin`。脚本使用 Bank 1 元数据副本和 SD 版 Retro-Go Bank 2，生成 `out/profiles/sd-<备份名>-<接线>.gnw.json`。

`SD_WIRING=spi1|ospi` 必须匹配固件的接线：`spi1` 为硬件 SPI，`ospi` 为复用外部 Flash 引脚的软件 SPI。切换选项不会改写固件。资源默认来自当前仓库；`GNW_ASSET_DIR=/path/to/asset-project` 可指定已准备的资源项目，`SDCARD` 可指定源卡镜像。`ROMS`、`SYSTEMS` 和 `CORES_FROM` 用于首次制作卡；已有卡不会因修改这些变量自动重建。

`scripts/run_sd_update.sh` 用于模拟从卡安装 Retro-Go 的流程，依赖预先准备的补丁固件和卡资源，具体目录布局与构建步骤见 [SD 文档](../sdcard.md)。

双启动固件通常从原厂时钟按住 **← + G** 进入 Retro-Go。卡升级完成后按任意键，再按 **← + G** 进入 Retro-Go SD。首次的 “PRESS TIME BUTTON” 可按 `T`。入口不会自动模拟这些按键；组合键是否有效取决于固件构建。

## 构建与存档

入口会检查桌面依赖和构建产物：缺少内核时调用 `scripts/build.sh`，缺少 `node_modules` 时执行 `npm ci`，缺少桌面产物时执行 `npm run build`。修改源码后仍需主动重新构建；入口不监听源文件变化。

配置不变时重复启动复用同一身份和存档。备份/SD 入口的 `FRESH=1` 创建新身份，保留旧存档；SD 模式未显式提供 `SDCARD` 时还会重建生成卡，显式指定的源卡不会被重建。

应用首次启动复制源镜像，后续只写会话副本。开发版数据默认在仓库的 `UserData` 下，可通过 `--user-data-dir` 覆盖。目录包使用系统应用数据目录，Windows 绿色版使用程序旁的 `UserData`。详情见[数据与存档](../user-guide.md#saves-and-your-source-images)。
