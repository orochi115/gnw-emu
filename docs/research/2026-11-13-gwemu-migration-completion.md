# gwemu 与 gnwmanager 迁移完成验收

日期：2026-11-13。依据[原始三阶段设计](../superpowers/specs/2026-11-12-gwemu-toolchain-migration-design.md)、用户实机/实体手柄豁免、已生成 UserData 不兼容的修订和有限审查规则逐项核验。现行产品只维护 gwemu，完整备份与当前模拟设备管理统一到 gnwmanager。两个旧 fork 均已保存最终公开 tag 并核实 GitHub `archived=true`。父仓库只做本地提交，没有推送。

## 最终来源与实际产物

| 项目 | 最终身份 |
| --- | --- |
| gwemu 公开 clean source/父 gitlink | `57b2b378e2001f20a241ecbaf9ce7c8f22aae9a3`，`orochi115/gwemu:gnw-emu`，保留 slash-proc 上游来源/历史 |
| manager 公开 clean source/父 gitlink | `9ef9cead5bd684cf47c39ccbd157a29ba01172b7`，`orochi115/gnwmanager:gnw-emu` |
| `build/gwemu/qemu-system-arm` | SHA256 `f41b093d72a03f0354e8e3c88b827e59a398eeccf0b9765f48f18a8cfa4ebdbd` |
| `desktop/release/mac-arm64/gnw-emu.app` 的 staged native | SHA256 `4c274a3a9c3104ef2b9de1e963e741001548ef9e51f7f76496ade9ffd056fd73` |
| RAM 管理固件 | 49440 字节，SHA256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`，既有 clean `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b` 固件构建 |

manifest 记录实际源码、配置、编译器/依赖和产物哈希。上游版本日期标头会使增量构建重新链接，因此保证来源可追溯而非跨构建逐字节相同。历史入口复核后以最终产物重跑 native/包回归、staging 和哈希审核；此前不同哈希的有效源代码/工作流证据明确保留。

## 原始要求逐项对照

以下列出各软件要求的有效验证；实机和实体手柄仅标用户豁免。不同批次的通过证据按用户规则复用，保留的失败与测试限制见后文。具体执行与原始日志索引见[产品验收](2026-11-13-gwemu-product-acceptance.md)。

| 原要求 | 实际实现与验证证据 |
| --- | --- |
| 架构职责、`.gnw.json`、生命周期 | UI 管理 profile/session/native 并保持 QMP 所有权；gwemu 模拟机器；manager 使用私有会话控制/GDB。无 ROM 零 native、换 ROM 新 UUID、关闭清理通过，无常驻 daemon。配置映射设备参数，不让固件解析 JSON |
| 阶段一 1：固定 commit/工具链来源 | 两个现行公开仓库 clean/remote exact SHA 与父 gitlinks 一致，构建和包 manifest 实际验证 |
| 阶段一 2：独立构建/同镜像对照 | [首批基线](2026-11-12-gwemu-baseline.md)记录四类同源复制镜像、哈希及两内核运行；captured 只表示观察，不冒充功能等价。现行构建仅 `build_gwemu.sh`，无旧机器注入 |
| 阶段一 3：参数、QMP/QOM、帧、音频、输入、RTC、UID、持久化/锁 | controller、native、真实 Electron 和目录包验证；[音频](2026-11-12-gwemu-audio.md)、[CoreAudio](2026-11-12-gwemu-coreaudio.md)、[共享输出](2026-11-13-gwemu-coreaudio-sharing.md)、[RTC](2026-11-12-gwemu-rtc.md)、[手柄](2026-11-12-gwemu-gamepad.md)。现行 native 240 项直接通过，原有效功能证据复用 |
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

## 本地主线合并前的退出与显示收尾

前面退休时的 185 项 native、旧包和保护审计为历史批次。其后的 device parity 源码为本表当前 `57b2b378…`；`out/gwemu-device-fixes/final-direct.log` **240 项通过**，`clean-firmware-final.log` **14 项 copied firmware 通过**，仍适用于本轮未修改的 native。现行 macOS 应用已重新打包，不能沿用旧包哈希或旧目录包验收。

LCD 保持 transport/backing canvas 640×480，窗口与 renderer 均按硬件 LCD 320×240 计算物理尺寸；带边框和 plain 的预设、全 LCD 棋盘像素、手动尺寸、缩放保存/重开均纳入验收。

macOS 的“Electron 退出时意外关闭，是否重新打开窗口”确实源自应用退出崩溃，而非仅测试 debugger 阻塞。普通 Electron 无 debugger 也 SIGTRAP；最小复现仅组合 BrowserWindow 与 Node IPC 接收监听 Server FD 就出现 `base/files/scoped_file.cc: Bad file descriptor`。Electron 39.8.10 和临时 40.10.6 均复现，不声称已确认上游 issue 或修复版本；产品依赖保持 39。

现有私有 Unix listener 改由附属 Node 进程持有，通过带每监听器随机凭据的 127.0.0.1 TCP 转发，不向 Electron 传 FD。复用原 exclusive hardlink、0600/uid/dev/ino 验证和只清理自有 inode 的契约，附属进程关闭时回收、父 IPC 断开时退出，无独立常驻 daemon。固定认证截止、fragment/coalesced payload、1 MiB EOF/背压、GDB admission pause、外来文件/socket 替换与取消/启动超时均有回归。

限定独立审查发现一项 P2：inactivity timeout 允许 trickling peer 延长待认证占用。真实 red/green 测试确认后改为固定认证截止，最终 **14 项 listener 单元测试通过**；**29 项真实 native manager server 集成通过**。原 owner-disconnect 测试现在等待真实服务端 abort 信号，不假设本机传输能在两个 event-loop tick 内完成断开。

**普通无 debugger 桌面回归 3 项通过**：idle/Mario/Zelda 各连续启动退出 3 次，共 **9 次 code=0、signal=null**，native/automation endpoint 释放、clock preference 保存和重开通过。仅测试使用 Cocoa ignore-state 标志避免历史崩溃弹框阻塞；退出码仍严格校验，生产不加抑制弹框开关。已留存的旧提示可选择“不重新打开窗口”。**真实桌面 manager 13 场景通过**，含 RPC/GDB 断点/单步、monitor、完整备份恢复、两 SD 接线、供电、三种中断和无 ROM 零 native。

标准浏览器鼠标/键盘组合输入（两次独立按下/释放）、Zelda/Mario backing/physical LCD、两款 pixel-presets/restart、desktop clock 与设置持久化 **7 项通过**。原有 mixed-input 用例（混合 Playwright 与 Electron ui.pointer/ui.key）首轮通过，此后重复运行出现 Chromium 提前 `lostpointercapture(buttons=0)`；应用按既有 guard 释放自有按钮。等待固件帧和修改注入 modifiers 的诊断没有完整解决，均已回退。此原用例作为**未关闭的合成输入稳定性限制**保留，不计本轮全套通过；目前没有直接证据说明标准浏览器输入或真实鼠标存在同一故障，新增独立浏览器组合用例验证的是公开真实事件路径，不改变 lost-capture 释放保护。按用户仅实证 Important/Critical 阻塞的有限规则，此问题不扩大为新内核退休门槛。

最新实际目录包 **2 项通过/8.0s**，无 Cocoa ignore-state 参数：stock Zelda 的显示/controls/自动化，以及 idle→ROM→manager→USB-only→save→关闭重开→load 全链路。包内7个运行文件、native/original manifest 和20个 relocated libraries 的 hash audit 通过。类型检查/build/diff check 通过；重新核验10个原始镜像和93个 UserData/用户 `.superpowers` 文件的内容、大小、mtime不变。包路径 `desktop/release/mac-arm64/gnw-emu.app`；包验收日志 `out/gwemu-exit-relay-package-verified.log`。父仓库按授权只本地 fast-forward 合并至 master，保留 feature 分支、旧历史tag/checkout/build，不 push。

本轮日志：`out/gwemu-exit-relay-listener-final.log`、`gwemu-exit-relay-manager-regression.log`、`gwemu-exit-relay-exit-manager-final.log`；历史失败日志保留，不将分批结果冒充一次全绿。测试只使用临时 UserData/会话副本，原镜像不作为写入目标。

## 明确边界

实机（含 SD 改装机）和实体手柄按用户决定豁免，由用户之后验证。Windows/Linux 包未在本机实际构建；真实 SSH 主机仅有受控传输 runner 覆盖，不宣称真实远端连接通过。供电为板级模型，不模拟全部电池曲线/充电器电气行为；完整 MCU Stop/Standby 时序、DAC 外部触发、实验性 CPU/cache 周期模型不宣称硬件等价；SD/超过 64 MiB external flash 的即时存档仍明确拒绝；声学音质/端到端延迟、所有 STM32 抗调试通道或实机熔丝行为不由模拟器结果证明。三阶段的产品路径与历史退休已完成；上述合成输入稳定性限制保持公开记录，不宣称所有测试一次全绿。
