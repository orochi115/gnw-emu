# gwemu 唯一产品内核与旧依赖退役设计

原三阶段路线最后的产品和历史收尾。用户已授权推进到结束，实机与实体手柄验收豁免；父仓库只本地提交，公开 manager/native 发布及原路线旧 fork 最终 tag/归档在验收后执行。所有真实源镜像、历史备份、实际产品 UserData、旁 manager、PID16603与用户 `.superpowers/` 在开发/验收期间保留。

## 唯一执行内核

桌面、CLI、launcher、packaging 和默认构建统一使用 pinned gwemu，移除 legacy 执行分支及 preview-only/isolated-userData限制。开发产物规范路径为 `build/gwemu/qemu-system-arm`，`scripts/build.sh`委托既有可复现 `build_gwemu.sh`；不复用/覆盖原 `build/qemu-system-arm`，原进程可以继续运行。测试通过环境变量显式选择审查过的 canonical产物；native新版构建manifest和实际hash重新记录，不能沿用旧SHA断言。

产品保持 `.gnw.json`、ROM加载时启动native、换ROM新runtime身份、无ROM不启动模拟器。旧 `--kernel=legacy` 明确报错；可保留 `--kernel=gwemu`兼容参数，但不留下双执行实现。新即时存档继续校验 gwemu 内核与实际二进制身份；不增加旧目录扫描或旧 slot 兼容逻辑。

设置 `realtime` 在gwemu过去两个值均未产生不同执行模式。最终UI不继续提供无效开关；保存的旧设置保持可读，gwemu使用已经验证的plainTCG/虚拟RTC暂停语义，不新增快进承诺。历史音频/显示/输入/电源/RTC/UID/SD两接线/完整Flash回滚能力保持，软件pad验证继续，实体pad只记录豁免。

## 用户数据范围（2026-11-13 用户修订）

用户明确不要求兼容已经生成的 UserData。取消 legacy session 自动复制导入、migration 元数据与通知、旧 namespace slot 查找，以及仅为导入服务的 native `--gnw-session-guard` / 同锁原子 publication 工具和专用测试。原 Task 1/2 仅有准备资料，未实施；这些旧准备不再是执行授权。

gwemu 活动 session 保留 `UserData/kernels/gwemu/sessions/<profileId>`。首次创建从 `.gnw.json` 配置指定的 ROM/Flash/SD baseline 复制到独立 session，源文件不作为 native 写入目标；后续读取和持久化正常 gwemu session。保留正常电池/USB/RTC、即时存档及 build 身份校验。新 session 不自动继承 legacy 保存的写入内容或状态。

已有 legacy UserData、session、slots 及本机历史副本保留原处，不导入、不覆盖、不删除。原 ROM/SD 输入与 `.gnw.json` 工作流保留。gnwmanager 旧备份归档格式支持属于独立既定要求，本次范围修订不取消它。

## 打包与运行来源

stage脚本默认canonical gwemu，拒绝缺失/dirty/来源不符manifest。mac install_name_tool/codesign会改变binary，因此记录sourceSHA、revision、configure/toolchain及staged实际SHA/libraryhash，原manifest与package-stagingmanifest一起打包。runtime savestate使用实际运行binarySHA，不假装relocation后仍是源SHA。打包不带ROM/SD/旧session。

实际macOS directory package用隔离UserData启动：无ROMnative数量零→copiedprofile启动→显示/输入/音频/供电/manager发现→停止持久化→再打开→ownedcleanup。Windows/Linux产物未实际构建不能报告通过；不扩大本次本机验收范围。

## 历史引用与退出依赖

所有退出门槛成立后，保留旧native fork、backup fork和父历史快照最终tag（不发布父tag，因为父仍本地-only）。历史说明必须有完整refs与构建命令：旧QEMU子模块是 `bf6c2d6a54bc24a453a1b9cf37a71892106fe3a4`，还依赖父 `qemu-gnw` 机器源码，不能只给QEMU fork SHA；旧backup `c4c807cbf1251b0268cf395d90cdd62d541f23b1`，旧归档文件全部保留。

先确认远程历史refs/tag存在，再从维护中的 `.gitmodules` 和git index移除qemu/backup、旧machine/snapshot hook、旧build运行脚本和只针对旧内核的工具/测试引用。本机历史工作副本/build目录仍保留且ignore，不用 `git submodule deinit` 或递归删除破坏运行环境。支持复现历史的脚本/说明用固定历史快照，不让现行build偷偷依赖oldtree。历史研究报告保留引用，并区分历史描述与当前使用说明。

通过授权GitHub操作归档 `orochi115/qemu` 和 `orochi115/game-and-watch-backup`，确认archived状态；manager/gwemu仍公开且可贡献上游。父只localcommit，最终gitlink匹配审查后实际remoteSHA。若远程归档工具失败保留明确未完成项，不伪称完成。

## 验收边界

新 gwemu session 与即时存档持久化、源镜像保护；product全unit/integration与关键Electron/launchers/package；完整manager命令与会话失效、两SD接线、backup恢复、native产物身份；最终逐项originalspec audit。十源hash/旁managerclean/16603存活/无任务遗留child均须最终实证。

按既定计划和用户最新有限审查规则执行；不恢复开放式反复 APPROVED 循环，也不新增完成门槛。此文不是实现或完成声明。先完成完整backup与session接口的有序评审，再执行本子项目，禁止提前退休对照环境。
