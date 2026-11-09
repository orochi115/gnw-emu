# 一键启动固件

在当前工作区 `/Users/sakura/GameWatch_Zelda`：

```sh
./run_stock_emu.sh                 # 原版 Zelda
./run_stock_emu.sh mario           # 原版 Mario
./run_backup_emu.sh                # 完整 dump（bank1.bin、bank2.bin、ext.bin）
./run_sd_emu.sh                    # 已准备的 Retro-Go SD 固件 + SD 卡
./run_sd_update_emu.sh             # 补丁原厂 + SD bootloader，从卡安装 Retro-Go
```

这些父目录脚本自动优先选择存在桌面工程的 `gnw-emu-electron-ui`，其次 `gnw-emu`；用 `GNW_EMU_DIR=/绝对/项目路径` 覆盖。脚本从自身位置解析目录，所以从其他 cwd 也能运行。它们和共用的 `gnw_emu_common.sh` 不属于 gnw-emu Git 仓库，此工作区已单独修改；仓库内对应入口始终可用：

```sh
scripts/run.sh zelda
scripts/run.sh mario
scripts/run_backup.sh [备份目录]
scripts/run_sd.sh [备份目录]
scripts/run_sd_update.sh
```

默认 dump 为工作区 `game-and-watch-backup/backups/full_20261104_1021`；可用位置参数或 `GNW_BACKUP_DIR` 覆盖。所有入口透传 Electron 参数，支持只有参数而省略备份目录：

```sh
./run_backup_emu.sh --language=en --debug
./run_sd_emu.sh --automation --user-data-dir=/tmp/gnw-ui-check
SD_WIRING=ospi ./run_sd_emu.sh --language=zh-CN
```

开始前检查 Node、QEMU 和桌面依赖/产物；缺少 QEMU 时调用 build.sh，缺少 node_modules 时 npm ci，缺少桌面构建产物时 npm run build。正常已准备环境不会反复构建。修改源码后仍须主动 npm run build；它不是文件监听器。Node24、QEMU 构建依赖和首次 SD 资产构建依赖见 development.md、../sdcard.md。

SD 资源默认来自当前项目；当前 worktree 未构建 SD 资源时，会只读复用旁边原 `gnw-emu` 已构建的资产。`GNW_ASSET_DIR=/资产项目` 可显式指定，`SDCARD=/卡镜像` 可指定源卡。新 profile、Bank 1 元数据副本、空白 Bank 2 和存档写新版项目。缺资源时才执行原来的固件/核心/卡准备步骤；显式资产目录缺少所需固件会报出具体路径，不修改它。

SD 卡接线 `SD_WIRING=spi1|ospi` 会使用不同 profile；SPI1 为默认硬件 SPI，ospi 为复用外部 Flash 引脚的软件 SPI。选择必须匹配固件构建/补丁使用的接线，切换选项不会改写固件。`ROMS`、`SYSTEMS`、`CORES_FROM` 用于首次制作卡；已有卡不会因修改这些变量自动重建。

配置不变时重复启动复用同一新格式身份和存档。dump/SD 的 `FRESH=1` 创建新身份并保留以前的存档。SD 未显式提供 SDCARD 时同时重建新版目录内的卡；显式提供源卡时只创建新身份，绝不重建该源卡。应用首次启动复制源镜像，后续只写会话副本；没有旧 Python 存档迁移。

原版时钟按住 **← + G** 进入 Retro-Go。SD 升级入口先显示原版界面，按 **← + G** 更新；完成后按任意键，再按 **← + G** 进入 Retro-Go SD。首次的 “PRESS TIME BUTTON” 可按 T，或直接 ← + G。启动脚本不自动模拟这些按键。

验证：shell fixture 使用真正的 Node profile 服务，仅替代最终 GUI launch，覆盖空格路径、参数透传、身份与源镜像不变。真实工作区 smoke 可显式执行：

```sh
cd desktop
GNW_LAUNCH_TEST=1 npm run test:e2e -- tests/e2e/launchers.spec.ts
```

该测试分别启动四个父目录脚本，通过真实窗口/Canvas/JSON-RPC读取，再调用原生菜单退出，检查隔离 session.json 和 endpoint 清理；不修改应用正常存档。此场景验证启动与退出，不代替完整 SD 刷写流程的硬件回归。
