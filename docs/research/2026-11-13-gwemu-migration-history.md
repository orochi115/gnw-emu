# gwemu 迁移历史与旧实现复现

日期：2026-11-13。现行产品只使用 gwemu 和 gnwmanager。旧源码从维护索引移除，但本机历史工作副本、构建、用户镜像/备份/session/slots 和原 legacy 进程保持原处。

## 固定历史引用

三个仓库使用同名轻量 tag `gnw-emu-legacy-final-2026-11-13`，未覆盖任何已有引用。

| 仓库 | 最终引用 | 发布范围 |
| --- | --- | --- |
| gnw-emu 父仓库 | `270569502a8a9458b43f85e0a5365fdc608365a7` | **仅本地 tag/commit，未推送父仓库**；包含完整旧机器、构建脚本、savestate hook 和旧 gitlinks |
| [orochi115/qemu](https://github.com/orochi115/qemu/tree/gnw-emu-legacy-final-2026-11-13) | `bf6c2d6a54bc24a453a1b9cf37a71892106fe3a4` | 已公开推送 tag，远程 exact SHA 已核对；原分支 `feat/gnw-savestates` |
| [orochi115/game-and-watch-backup](https://github.com/orochi115/game-and-watch-backup/tree/gnw-emu-legacy-final-2026-11-13) | `c4c807cbf1251b0268cf395d90cdd62d541f23b1` | 已公开推送 tag，远程 exact SHA 已核对；原分支 `full-backup-restore` |

父仓库公开 `master` 为 `bbcb518a16abbba012d6f44d817f32e2203d4d4b`，远程存在已核对。该公开历史提交包含相同旧 `qemu-gnw` tree（`9a41f60d00ce388aea6410a51f6c17c6dbd1869d`）、相同 savestate hook blob（`2b21f2be9e4094b373acf62a320d9ddf660d5b8b`）和最终 QEMU gitlink，能够复现公开旧机器基线；它不是包含全部后续迁移/验收文件的本地最终父快照。不要在公开仓库声称本地 tag 已可下载。

## 完整本地快照复现

在新目录从拥有本地历史提交的仓库克隆，避免切换或改写当前工作区：

```sh
git clone --no-hardlinks /path/to/gnw-emu /path/to/gnw-emu-legacy-reproduction
cd /path/to/gnw-emu-legacy-reproduction
git checkout gnw-emu-legacy-final-2026-11-13
git submodule update --init externals/qemu externals/game-and-watch-backup
git -C externals/qemu checkout bf6c2d6a54bc24a453a1b9cf37a71892106fe3a4
git -C externals/game-and-watch-backup checkout c4c807cbf1251b0268cf395d90cdd62d541f23b1
scripts/build.sh
```

旧 QEMU 的 `hw/arm/gnw` 是相对符号链接 `../../../../qemu-gnw/hw/arm/gnw`。必须同时恢复父快照的 `qemu-gnw/hw/arm/gnw` 和 `scripts/qemu-savestate-hook.py`；单独下载 QEMU tag 不足以构建旧机器。历史 `scripts/build.sh` 负责链接/meson/Kconfig/hook，并输出旧布局 `build/qemu-system-arm`。需要当时的 Python、Ninja、pkg-config、GLib/Pixman 及 C 编译器；macOS 脚本优先 Homebrew pkg-config。不承诺跨宿主逐字节相同。

只需公开旧机器基线时，可从父仓库远程克隆后 checkout 已公开的 `bbcb518a16abbba012d6f44d817f32e2203d4d4b`，再执行相同子模块/构建步骤；不要尝试下载未发布的父 tag。QEMU tag 的推送 remote 是 `orochi115`，旧 checkout 的 `origin` 指向 GitLab 上游，不能误把历史集成 tag 推往上游。

## 已退休与保留的内容

维护索引退出旧 QEMU/backup 两个子模块、旧机器 `qemu-gnw`、savestate 注入 hook、legacy Python runtime/bench runner 和专用测试，以及双内核比较工具。没有执行 submodule deinit、删除工作副本或删除旧 build。37 个本机历史源码文件移除前后逐字节哈希一致，两个旧子模块仍在原位置、HEAD 不变；保留记录在 `out/gwemu-completion/retirement-preservation-before.json` 和最终审计。

现行构建只初始化 `externals/gwemu`、`externals/gnwmanager` 及需要的固件/core 子模块。中立 `harness.assets` 与 `harness.sd_assets` 提供输入路径/ELF 符号；gwemu 测试不依赖旧 runtime 或旧测试导入。保留在本机的 retired 测试由 collection ignore 排除；新 checkout 本就不包含它们。

既有完整 dump 目录仍可作为用户输入，路径里出现 `game-and-watch-backup/backups` 不代表执行旧 backup 代码。备份、验证、恢复和拉取使用当前 gnwmanager；旧归档格式支持保留，真实输入资产不移走。过去的研究报告、hwtest 结果和比较工具指令均为历史记录，使用历史快照复现。

最终归档结果及完整验收对照以[迁移完成报告](2026-11-13-gwemu-migration-completion.md)为准；本历史文档不以 tag 发布代替 archive 状态核验。当前 gwemu/gnwmanager 保持正常维护。实机与实体手柄未在此次迁移验证。
