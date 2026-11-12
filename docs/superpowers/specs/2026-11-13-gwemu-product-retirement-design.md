# gwemu 唯一产品内核与旧依赖退役设计

原三阶段路线最后的产品和历史收尾。用户已授权推进到结束，实机与实体手柄验收豁免；父仓库只本地提交，公开 manager/native 发布及原路线旧 fork 最终 tag/归档在验收后执行。所有真实源镜像、历史备份、实际产品 UserData、旁 manager、PID16603与用户 `.superpowers/` 在开发/验收期间保留。

## 唯一执行内核

桌面、CLI、launcher、packaging 和默认构建统一使用 pinned gwemu，移除 legacy 执行分支及 preview-only/isolated-userData限制。开发产物规范路径为 `build/gwemu/qemu-system-arm`，`scripts/build.sh`委托既有可复现 `build_gwemu.sh`；不复用/覆盖原 `build/qemu-system-arm`，原进程可以继续运行。测试通过环境变量显式选择审查过的 canonical产物；native新版构建manifest和实际hash重新记录，不能沿用旧SHA断言。

产品保持 `.gnw.json`、ROM加载时启动native、换ROM新runtime身份、无ROM不启动模拟器。旧 `--kernel=legacy` 明确报错；可保留 `--kernel=gwemu`兼容参数，但不留下双执行实现。`StateIdentity`仍识别legacy以拒绝旧即时存档，不能为了删执行代码删掉历史识别。

设置 `realtime` 在gwemu过去两个值均未产生不同执行模式。最终UI不继续提供无效开关；保存的旧设置保持可读，gwemu使用已经验证的plainTCG/虚拟RTC暂停语义，不新增快进承诺。历史音频/显示/输入/电源/RTC/UID/SD两接线/完整Flash回滚能力保持，软件pad验证继续，实体pad只记录豁免。

## 旧 session 保存内容的迁移

gwemu活动session保留 `UserData/kernels/gwemu/sessions/<profileId>`，已有gwemu数据优先且绝不覆盖。若仅旧 `UserData/sessions/<profileId>` 存在，不能从profile baseline重新seed而丢失已保存Flash/SD更改；自动执行一次性复制导入，旧session和旧states目录留在原处。

复制前先获得旧UI目录lease，防止旧UI继续启动；还必须持有旧 native 的 `qemu.lock` 相同 byte-range advisory lock，不能只看PID/文件存在或做一遍lsof。直接运行的旧native可能没有UIlease，因此两个锁都必须通过。活动旧native包括原PID16603只能让导入明确拒绝，提示用户以后自行关闭；不终止它，不复制活动映射。

为使macOS/Linux打包版不依赖系统Python或Node原生addon，给native增加小型 `--gnw-session-guard <lockfile>` 模式：guest初始化前用与旧 `qemu_lock_fd(fd,0,1,true)` 相同机制持锁，stdout返回一行有限JSON ready，持有到stdin EOF/终止，关闭fd退出；不启动CPU/设备/网络。guard可在ready后接收唯一COMMIT，将已校验staging用原子no-replace发布为目的目录；publication必须在同一持锁进程内执行，不创建第二个不持source锁的publisher。COMMIT发送前可取消并保证不发布，发送后UI停止阻止guest启动但不能撤回已完成原子提交，有限ack/退出与importId核对明确完成或未知结果。UI仅在加载ROM且需要导入时创建此owned transienthelper，验证同UID普通文件/非symlink、有限startup/退出deadline。native实现单独文件，主程序只做选项分流，不扩展普通QMP为任意文件操作。Windows不能声称POSIX锁验证通过，已有platform能力拒绝路径必须清楚。

双锁持有期间验证旧session元数据与exact image类型/长度/模型/容量、复制bank1/外Flash/可选bank2/SD及可识别持久化sidecar到gwemu namespace下新staging目录，普通文件不接受symlink/hardlink指向baseline；全份SHA确认copy一致。session电池/USB/RTC及寿命设置保留，新batteryPresent采用旧语义存在电池；不复制runs、socket、lease、qemu.lock或旧VMslot。新元数据带migration来源版本及每文件SHA，仅atomicrename暴露完整session。导入失败保留旧数据、新目录不成为有效session；退出双锁helper。再对实际导入镜像做gwemu preflight，不能只验证baseline尺寸。

新session首次创建仍复制baseline；源镜像永不作为native写入目标。旧states保留，旧v1/legacy slot若用户尝试加载应明确提示内核不兼容；文档说明旧保存的Flash数据已迁入，CPU即时状态无法跨内核复用。校验和lease全部测试使用新建fixture，不实际迁移本机用户产品数据。

## 打包与运行来源

stage脚本默认canonical gwemu，拒绝缺失/dirty/来源不符manifest。mac install_name_tool/codesign会改变binary，因此记录sourceSHA、revision、configure/toolchain及staged实际SHA/libraryhash，原manifest与package-stagingmanifest一起打包。runtime savestate使用实际运行binarySHA，不假装relocation后仍是源SHA。打包不带ROM/SD/旧session。

实际macOS directory package用隔离UserData启动：无ROMnative数量零→copiedprofile启动→显示/输入/音频/供电/manager发现→停止持久化→再打开→ownedcleanup。Windows/Linux产物未实际构建不能报告通过；不扩大本次本机验收范围。

## 历史引用与退出依赖

所有退出门槛成立后，保留旧native fork、backup fork和父历史快照最终tag（不发布父tag，因为父仍本地-only）。历史说明必须有完整refs与构建命令：旧QEMU子模块是 `bf6c2d6a54bc24a453a1b9cf37a71892106fe3a4`，还依赖父 `qemu-gnw` 机器源码，不能只给QEMU fork SHA；旧backup `c4c807cbf1251b0268cf395d90cdd62d541f23b1`，旧归档文件全部保留。

先确认远程历史refs/tag存在，再从维护中的 `.gitmodules` 和git index移除qemu/backup、旧machine/snapshot hook、旧build运行脚本和只针对旧内核的工具/测试引用。本机历史工作副本/build目录仍保留且ignore，不用 `git submodule deinit` 或递归删除破坏运行环境。支持复现历史的脚本/说明用固定历史快照，不让现行build偷偷依赖oldtree。历史研究报告保留引用，并区分历史描述与当前使用说明。

通过授权GitHub操作归档 `orochi115/qemu` 和 `orochi115/game-and-watch-backup`，确认archived状态；manager/gwemu仍公开且可贡献上游。父只localcommit，最终gitlink匹配审查后实际remoteSHA。若远程归档工具失败保留明确未完成项，不伪称完成。

## 验收边界

真实session import双锁竞态、copy失败atomicity、existinggwemu优先、旧slots拒绝、无baseline写入；product全unit/integration与关键Electron/launchers/package；完整manager命令与会话失效、两SD接线、backup恢复、native产物身份；最终逐项originalspec audit。十源hash/旁managerclean/16603存活/无任务遗留child均须最终实证。

仍需独立设计审查、详细计划、TDD、规范和质量审查；此文不是实现或完成声明。先完成完整backup与session接口的有序评审，再执行本子项目，禁止提前退休对照环境。
