# gwemu 与 gnwmanager 迁移完成验收

日期：2026-11-13。依据[原始三阶段设计](../superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md)、用户实机/实体手柄豁免、已生成 UserData 不兼容的修订和有限审查规则逐项核验。现行产品只维护 gwemu，完整备份与当前模拟设备管理统一到 gnwmanager。两个旧 fork 均已保存最终公开 tag 并核实 GitHub `archived=true`。父仓库只做本地提交，没有推送。

## 最终来源与实际产物

| 项目 | 最终身份 |
| --- | --- |
| gwemu 公开 clean source/父 gitlink | `a38484468d947ce6447fcc7dec47ebeef041f853`，`orochi115/gwemu:gnw-emu`，保留 slash-proc 上游来源/历史 |
| manager 公开 clean source/父 gitlink | `9ef9cead5bd684cf47c39ccbd157a29ba01172b7`，`orochi115/gnwmanager:gnw-emu` |
| `build/gwemu/qemu-system-arm` | SHA256 `f6d37ae14c0075f970cea501234a711072ea2cd64cbfb6defa7327573d0b5552` |
| `desktop/release/mac-arm64/gnw-emu.app` 的 staged native | SHA256 `6a0003f8f5d246a7cbdfed45451152f79dc28ac93e66f907607096fffd2212c4` |
| RAM 管理固件 | 49440 字节，SHA256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`，既有 clean `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b` 固件构建 |

manifest 记录实际源码、配置、编译器/依赖和产物哈希。上游版本日期标头会使增量构建重新链接，因此保证来源可追溯而非跨构建逐字节相同。历史入口复核后以最终产物重跑 native/包回归、staging 和哈希审核；此前不同哈希的有效源代码/工作流证据明确保留。

## 原始要求逐项对照

以下软件要求全部通过；实机和实体手柄仅标用户豁免。具体执行与原始日志索引见[产品验收](2026-11-13-gwemu-product-acceptance.md)。

| 原要求 | 实际实现与验证证据 |
| --- | --- |
| 架构职责、`.gnw.json`、生命周期 | UI 管理 profile/session/native 并保持 QMP 所有权；gwemu 模拟机器；manager 使用私有会话控制/GDB。无 ROM 零 native、换 ROM 新 UUID、关闭清理通过，无常驻 daemon。配置映射设备参数，不让固件解析 JSON |
| 阶段一 1：固定 commit/工具链来源 | 两个现行公开仓库 clean/remote exact SHA 与父 gitlinks 一致，构建和包 manifest 实际验证 |
| 阶段一 2：独立构建/同镜像对照 | [首批基线](2026-11-12-gwemu-baseline.md)记录四类同源复制镜像、哈希及两内核运行；captured 只表示观察，不冒充功能等价。现行构建仅 `build_gwemu.sh`，无旧机器注入 |
| 阶段一 3：参数、QMP/QOM、帧、音频、输入、RTC、UID、持久化/锁 | controller、native、真实 Electron 和目录包验证；[音频](2026-11-12-gwemu-audio.md)、[CoreAudio](2026-11-12-gwemu-coreaudio.md)、[共享输出](2026-11-13-gwemu-coreaudio-sharing.md)、[RTC](2026-11-12-gwemu-rtc.md)、[手柄](2026-11-12-gwemu-gamepad.md)。最终 native 185 项直接通过，原有效功能证据复用 |
| 阶段一 4：镜像隔离与完整即时存档 | 只写 session；CPU/RAM/外设、完整 Flash/sidecar、RTC/供电恢复与失败回滚通过。[存档](2026-11-12-gwemu-savestate.md)及真实热键/槽位/重开证据；v2 校验内核/实际 build，native 校验 profile/config；SD 拒绝、ext 上限 64 MiB 保持 |
| 阶段一 5：电池、USB、冷启动、软件 SPI | 电池存在与电量分离，USB 可独立供电，无两种电源时停机，恢复供电暂停，显式 resume/cold-start；虚拟时间充放电。[供电](2026-11-12-gwemu-supply.md)、[桌面供电](2026-11-12-gwemu-desktop-supply.md)、[SD 两接线](2026-11-12-gwemu-softspi-sd.md)及最终 GUI/包/manager 实测 |
| 阶段一 6：集中小范围 native 适配 | 公开集成库保留上游历史，修改集中在产品接入和必要模型补齐；未复制 legacy STM32 整套实现。源码/patch 审查副本可追溯，不宣称已合并上游 |
| 阶段一验收：四类固件与 RAM manager | Mario/Zelda OFW、Flash-only Retro-Go、SPI1/OSPI SD 均使用复制镜像运行/输入/写入；[RAM manager](2026-11-12-gwemu-manager-ram.md)、产品与桌面报告保留真实固件证据和源哈希 |
| 阶段一退出：唯一内核与旧实现退休 | 产品/CLI/build/launchers/package 唯一 gwemu，legacy 参数报错。最终 tag/完整父快照/symlink/hook 复现说明已记录；旧索引/子模块退出，旧 QEMU fork archive，本机历史文件保留 |
| 阶段二：完整备份与原始现场 | 双 bank、全容量 ext、ITCM/选项字节/RTC extras、双读、大小/哈希 manifest；低层 capture 不先 reset/upload manager，complete/partial 原始寄存器/RAM/RTC 不变实测。[完整备份报告](2026-11-13-gnwmanager-full-backup.md) |
| 阶段二：verify/restore/fetch/旧格式与错误 | 独立 verify、选择/完整 restore 与重开持久化、容量/损坏拒绝、真实写入后读回错误、旧归档实际 restore、连续 manager 命令和本机 HTTP fetch/校验通过；options/RTC 归档不扩大恢复权限。104 集中/10 native 历史证据及最终无旧源码 checkout 实测保留 |
| 阶段二退出：backup 依赖/归档 | 公开 manager 提供 backup/verify/restore-backup/fetch-backup；旧执行依赖/子模块退休，已有用户备份保留；公开最终 tag exact SHA 与 fork archive 核验 |
| 阶段三 1：发现/无设备/多设备 | 本地私有 discovery/RPC、公开 sessions/--session UUID，按需发现；无设备报错、多设备明确选择。默认产品 13 个真实场景/40 次公开 CLI，无 backend/discovery 替身 |
| 阶段三 2：身份/退出/崩溃/失效 | UUID 绑定 runtime，不转向新 ROM；CLI/native/UI 中断、旧 UUID、外来 descriptor 和自有端点清理通过；失败明确 saveUncertain/部分完成，不把 Force Quit 当成功保存 |
| 阶段三 3：GDBBackend 与外部 GDB | 寄存器描述、分包/错误/总截止、halt/resume/reset、单客户端 lease/proxy 交接；真实 guest 的 RAM/寄存器、断点/单步、匹配 ELF monitor 通过。[client](2026-11-13-gwemu-session-client.md)、[CLI](2026-11-13-gwemu-session-manager-cli.md) |
| 阶段三 4：QMP 所有权/排他/中断 | UI 保持 QMP，manager 电源/输入经 UI；管理中禁换 ROM/存档/冲突输入。paused/running/unpowered 初态、过期授权/failed release 直接回归、UI 排他通过。[server](2026-11-13-gwemu-manager-server.md)、[controller](2026-11-13-gwemu-manager-controller.md) |
| 阶段三 5：完整命令清单 | 备份/校验/恢复、Flash 写/擦/读回、LittleFS 格式化/文件、两 SD API、截图、monitor/GDB、工厂 unlock/reprotect、执行/POWER/供电均实际验证；RAM 外设、[RDP](2026-11-13-gwemu-rdp.md)、冷启动/持久化证据保留。[真实桌面工作流](2026-11-13-gwemu-session-manager.md) |
| 已生成用户数据不兼容修订 | 不导入旧 UserData、不加 migration 元数据/通知、旧 slot 查找或 native import helper；新 session/slot 正常保存/加载；旧文件保留，原 ROM/SD/JSON 输入与 manager 旧备份格式支持继续 |

## 退休后的验证与保护

临时 checkout `/tmp/gnw-retirement-checkout-tlsnuq71` 从实际维护 index 导出，没有旧 QEMU/backup、`qemu-gnw`、legacy runtime 或旧测试；只共享现行来源/工具/构建目录。构建入口成功，最终维护测试收集 **307 项，无错误**，此数字仅为收集数量。独立 SD helper 读取的 1842 个 ELF 符号与旧 helper 实际结果完全一致。

manager/备份检查 **28 项通过**，包括全部 10 项真实备份用例；12 个备份证据记录最终 native SHA。首轮另有 1 个针对已删除 legacy skip 钩子的旧断言失败，该钩子专用测试随退休退出维护，未恢复旧 runtime 或放宽实际断言。`retirement-checkout-tests.log` 保留失败，不冒充整轮全绿；复用有效 28 项，最终 checkout collection 无错误。

最终 native **185 项通过/27.12s**；最终实际目录包 **2 项通过/8.1s**；四 launcher 4 项、原桌面失败直接回归 3 项、canonical manager-server 29 项、默认 manager 13 场景/40 CLI 均保留实际日志/身份。包内仅 cli/ui-cli，无旧比较 executor；7 个运行文件、native/original manifest 和 20 个 relocated libraries 哈希一致。类型检查与 diff check exit 0。其他有效结果按用户规则复用，失败日志不删除。

保护审计核验 10 个原始镜像 SHA 不变、实际 UserData 78 个文件大小/mtime 不变、用户 `.superpowers`/旁 manager status/revision 不变、原 PID 16603 完整命令保持。旧 `build/qemu-system-arm` SHA 仍 `49f522a529840e8bd7d4db83878690f590879ac934089a70de850a55cdb712fd`；37 个退休源码逐字节不变，两个旧子模块本机目录/HEAD 保留。owned native/client/endpoints 无遗留。最终记录：`out/gwemu-completion/migration-final-source.json`、`retirement-final-audit.json`。

公开最终 tag `gnw-emu-legacy-final-2026-11-13` 指向 QEMU `bf6c2d6a54bc24a453a1b9cf37a71892106fe3a4` 和 backup `c4c807cbf1251b0268cf395d90cdd62d541f23b1`。GitHub GET 核实旧两个 fork archived、现行 gwemu/manager unarchived。父同名 tag → `270569502a8a9458b43f85e0a5365fdc608365a7`，仅本地；父公开 master 仍 `bbcb518a16abbba012d6f44d817f32e2203d4d4b`。详见[完整历史与复现](2026-11-13-gwemu-migration-history.md)。

## 明确边界

实机（含 SD 改装机）和实体手柄按用户决定豁免，由用户之后验证。Windows/Linux 包未在本机实际构建；真实 SSH 主机仅有受控传输 runner 覆盖，不宣称真实远端连接通过。供电为板级模型，不模拟全部电池曲线/充电器电气行为；声学音质/端到端延迟、所有 STM32 抗调试通道或实机熔丝行为不由模拟器结果证明。三阶段的软件要求与历史退休已完成，没有剩余必需实现/验收项。
