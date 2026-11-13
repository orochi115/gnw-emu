# 子模块与仓库发布核验

2026-11-13 用户在退出修复、本地 master 合并与 macOS 包验收之后，明确授权检查子模块并推送相关仓库。本次授权取代此前父仓库只做本地提交的发布限制；先确认子仓库提交存在，再发布父仓库 master。

## 固定提交与地址

17 个一级子模块全部已初始化、工作区干净，实际 HEAD 与父仓库 gitlink 一致；`.gitmodules` URL、父本机 submodule URL、checkout 的 origin fetch/push URL 一致。远端 refs 或 GitHub commit API 核验全部17个固定提交存在。

12 个已初始化的嵌套子模块同样干净、gitlink 一致，固定提交可从配置的远端获取。另有22个未初始化的嵌套子模块：旧 Flash-only Retro-Go 的7个组件，以及 gwemu/QEMU 的15个其他机型 ROM/测试工具源码。它们当前无需参与 STM32H7/ARM 模拟器构建，未为本次发布下载或改写。需要这些其他目标时，可以按相应项目的构建说明执行 `git submodule update --init --recursive`。

| 自有仓库 | 发布分支 | 父仓库固定提交 |
| --- | --- | --- |
| `orochi115/gwemu` | `gnw-emu` | `57b2b378e2001f20a241ecbaf9ce7c8f22aae9a3` |
| `orochi115/gnwmanager` | `gnw-emu` | `9ef9cead5bd684cf47c39ccbd157a29ba01172b7` |
| `orochi115/game-and-watch-retro-go-sd` | `gnw-emu` | `a84fa44c6d9c07752dca37f3718ab951b6db5965` |
| `orochi115/game-and-watch-patch` | `gnw-emu` | `4702efac00e1d99ec2c4c254eef1e9bd01f71958` |
| `orochi115/game-and-watch-retro-go` | `rabbit-gnw` | `8efbaab1e23f9c663635d7af0b6f06f1141680ab` |

以上5个集成分支推送均返回 `Everything up-to-date`，远端对应分支 exact SHA 与 gitlink 匹配。HAL 与11个 upstream cores 继续使用已有固定提交，无须向第三方仓库推送。

## 本机配置收尾

- 执行 `git submodule sync --recursive` 同步当前已初始化模块的地址。
- 移除父 `.git/config` 中已退休 `externals/qemu` 与 `externals/game-and-watch-backup` 的遗留配置节；冻结的 checkout、源码、构建文件和历史 refs 保留。
- gwemu 的 origin 原来只 fetch `gnw-h7b0`。保留该映射，添加 `gnw-emu` 的远端跟踪映射，并设置本地 `gnw-emu` 跟踪 `origin/gnw-emu`。
- manager 本地分支名为 `gnw-emu-manager-ram`，已正确跟踪 `origin/gnw-emu`；本次使用明确 refspec 发布到 `.gitmodules` 指定分支。

本次没有改动 `.gitmodules`、gitlinks 或子仓库源码。父仓库发布目标为 `orochi115/gnw-emu:master`，包含已验收的退出修复 `ac02ff6` 和本次核验文档；推送使用 `--recurse-submodules=check` 检查提交可达性，不强推，不批量发布无关分支或 tags。保留本机未跟踪的用户 `.superpowers/`，它不进入提交。

软件验收与已记录限制见[迁移完成报告](2026-11-13-gwemu-migration-completion.md)。本次仅有 Git 本机配置与文档变化，复用已有有效的构建、退出、manager、macOS 包和 native 验收，不重复设备测试。本机详细核验输出在忽略的 `out/submodule-publish-*.json`，不发布运行 trace 或用户数据。

## gwemu fork 网络迁移

用户随后明确授权释放旧 QEMU 占用的 fork 网络名额，让现行 gwemu 成为真正的上游 fork，以便跟踪更新和将来贡献 PR。旧 `orochi115/qemu` 通过 GitHub Settings 的 **Leave fork network** 脱离；GitHub 后台完成后，API 核实 `fork=false`、`parent=null`、`archived=true`。仓库 ID 仍为 `1446808590`，全部914个分支/标签引用与迁移前快照一致，包括已发布的 legacy 最终标签。

原独立 gwemu 改名保留为 [`orochi115/gwemu-independent-backup`](https://github.com/orochi115/gwemu-independent-backup)，仓库 ID `1454747613` 与唯一的 `gnw-emu` 分支提交均保留。然后通过 `gh repo fork slash-proc/gwemu --fork-name gwemu --clone=false` 建立新的 [`orochi115/gwemu`](https://github.com/orochi115/gwemu)，仓库 ID 为 `1456552384`。API 核实其 `fork=true`、直接 `parent=slash-proc/gwemu`、网络根 `source=qemu/qemu`；slash-proc 本身是 QEMU fork，因此网络根仍是 QEMU。

将原 `gnw-emu` 分支推入新 fork，并设为默认分支，提交仍为 `57b2b378e2001f20a241ecbaf9ce7c8f22aae9a3`。现行 `.gitmodules`、本机 submodule URL、checkout 的 origin 和父 gitlink 均核实匹配；17个一级 submodule 的 HEAD 全部匹配父 gitlinks。公开 shallow/blob-filtered clone 验证新仓库的分支提交可以获取。本轮仅调整 GitHub 仓库关系、描述、默认分支和本机远端 refs，设备源码与构建产物无变化，未重复软件回归。

本机 `upstream` 继续指向 `https://github.com/slash-proc/gwemu.git`，并已获取 `upstream/gnw-h7b0` → `3bfce5fd26a402660a8526b3a7ffc92048c3966a`。本机 ancestry 检查和 GitHub [跨 fork 比较](https://github.com/slash-proc/gwemu/compare/gnw-h7b0...orochi115:gnw-emu)均确认：集成分支领先15个提交、落后0个。未来向 slash-proc 贡献时，PR 的目标分支为 `gnw-h7b0`；本轮未提交 PR。

迁移前后的完整仓库元数据、远端 refs 快照保存在本机临时目录 `gnw-fork-migration-m3erhtv8`，新 fork 克隆核验目录为 `gwemu-real-fork-vptqf293`。仓库内只记录核验结论，不提交这些临时证据或用户数据。
