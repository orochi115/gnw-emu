# 第一阶段验证记录

环境：macOS 15.6，Apple Silicon，Node24.8.0、Electron39.8.10，QEMU11.1.3原生arm64。截图/测量在未跟踪out/ui-validation。

首版验证（2026-11-09）：TypeScript typecheck、生产 build、macOS package:dir 均退出 0；Vitest **26 passed / 12 files**；普通 Electron E2E **3 passed / 2 skipped**（十分钟与目录包为显式启用测试），二者另行执行均 **1 passed**；原生 pytest 全量 **33 passed / 7 skipped**。跳过的是缺少额外固件/SD测试镜像的场景，不是缺少QEMU构建。目录包验证同时通过 Node ui-cli 连接运行中应用执行 capabilities、ui.inspect、logging.getConfig/tail；probe.sh 输出隔离寄存器与图像。shell语法检查和git diff --check通过。

已执行：真实QEMU帧握手/ACK/非法控制、背光、退出JSON、OS锁；JSON存档副本隔离、配置身份、日志级别/过滤/错误cause、有界recent cursor；真实QMP请求匹配；默认按键短按/组合键/失焦释放；完整启动/无效新ROM保留旧运行/退出保存；独立Playwright原生菜单及表单；JSON-RPC实际填表、系统保存取消替代、保存并加载、Canvas有效像素、源镜像SHA256不变；macOS目录包内置QEMU/依赖/automation启动。

声音：QEMU WAV宿主backend接收到非零双声道PCM，原有SAI波形无buffer seam回归通过；设备不可用不会在每个DMA半缓冲重试。宿主实际扬声器音量/音质仍需人工听音确认，文件捕获测试不能代替听音。

视觉：已实际查看640×480 CSS区域、Retina2x截图的浅色空态、制作表单和游戏画面，原生窗口控制保持系统行为。深色、380px窄窗口、错误、长路径和首个无效字段聚焦也已通过E2E并查看截图。制作表单有内部滚动区及始终可见的底部操作，游戏整数缩放并居中黑边。截图是窗口内容截图，不包含系统菜单栏。

性能：首版十分钟真实Electron/QEMU运行通过：61个样本，主进程RSS159.5–166.2MiB、结束161MiB，无持续增长；观测队列最多1帧、消费等待丢弃0；Canvas平均61.02次绘制/秒（36613次/600秒）。该场景为原厂游戏，非慢消费压力场景；慢消费另有单元背压测试。帧序号增长/Canvas绘制次数不等于60Hz有效画面变化；QMP成功不是输入到画面延迟。未进行真实物理显示器/输入延迟标定，因此不得声明达到稳定60Hz有效更新或特定端到端低延迟。

平台：macOS开发版和目录包运行已验证；Linux/Windows架构、路径、打包及Windows锁实现已预留，但没有这些执行环境，原生构建/目录包/系统菜单/声音/锁的实际运行均**未验证**。不能把macOS测试结果当成三平台完成证据。

需人工补验：每个平台真实系统文件对话框（测试替代只检验下游逻辑）、菜单展开及键盘焦点、强制退出警告、声卡选择/声音。自动化原生菜单操作仅覆盖Menu handler边界。

本轮完善验证（2026-11-09）：i18next 简体中文/英文、系统/配置/命令行语言优先级、三平台菜单模板和结构化错误；30 项 Vitest（14 files）通过；普通 Electron E2E 4 passed / 6 skipped（4 个固件启动、package、soak 是显式场景）。单选控件经过真实方向键和 JSON-RPC 点击，inspect.checked/locale 与真实 DOM 一致，radio 不能作为文本填入。UID 不再出现在制作 UI，SD 接线始终显示且随卡路径使能。

四条父目录启动脚本分别实际启动原版、完整 dump、SD 直启、SD 升级的 Electron/QEMU，4 passed；每次使用临时 UserData，检查 Canvas 递增、app.quit 正常退出、session.json 保存和 endpoint 清理。SD 实際使用原目录已有的 1 GiB 卡镜像，但本轮测试只验证启动/退出，不代替完整升级刷写和核心游戏回归。shell/JSON 服务测试 7 项通过，另外显示/退出快照/锁相关原生测试通过，合计 12 passed。源镜像不变、空格路径、参数透传、FRESH 新身份与原存档保留均有 fixture 验证。

本轮 typecheck/build/package:dir 成功；更新后的 macOS 目录包及 CLI smoke 1 passed。实际查看中文分段单选表单、英文和深色窄窗口；原生 role 菜单自动化采用对应 Electron 原生命令，因为 macOS MenuItem.click 不执行系统角色，仍不等于物理展开菜单的人工检查。Linux/Windows 实机状态保持未验证；十分钟数据来自首版，没有为本轮无显示管道变更的菜单/脚本补齐重复测试。

## 第二阶段：交互机身（2026-11-09）

新增 Mario/Zelda 官方图片提取、透明 LCD、独立按钮状态；原图不修改。离线验证覆盖完整透明孔、其余机身像素不变、60 张状态 PNG 的尺寸/alpha/范围，以及字节级可复现。运行应用不依赖 Python。

最终 typecheck/build 退出 0；Vitest **40 passed / 16 files**；普通 Electron E2E **6 passed / 6 skipped**，后六项仍为显式 soak、四个固件启动与 package。更新 macOS 目录包构建成功，独立目录包/CLI smoke **1 passed**，同时核对包内 Zelda 机身图片完成加载且 naturalWidth=950。

实际 Electron/QEMU 验证：两个机型 LCD 对齐与有效像素，View checkbox 与持久化/写入失败恢复，纯画面切换时运行 UUID 不变且帧序号继续递增；鼠标长按、键盘同键所有权、组合键、控件外释放、双来源同键取消、Chromium 双指触摸与 touchCancel、真实 Tab/Space 导航、Return 松开后焦点变化、失焦/模态清理、迟到旧运行输入拒绝。检查了浅/深主题、380/1000 CSS px、Retina 内容截图。

审阅发现的三个问题均有回归证据：异步保存期间新按下在隐藏前再次释放；Tab 从画面进入真实按键；旧聚合快照不能清理刚开始的本地来源，使用明确 resetGeneration，注入迟到快照的 E2E 在旧实现失败、修复后通过。设置测试覆盖连续切换、有序写入及失败后恢复。

稳定性备注：早期回归曾出现一次原有表单注入末尾字符重复，单独复核及三轮重复未再出现；一次长按重复场景收到提前的 pointer 来源释放。补充 DOM/Pino 失败诊断后，机身输入连续 **8 次通过**，最终全量也通过；这两项偶发现象未定位，不将重复通过表述为已彻底修复。后续失败 trace 附输入来源日志与 DOM 事件，以便复现分析。

本轮没有修改 QEMU/帧协议，未重复十分钟 soak 与完整原生 pytest。Linux/Windows 实机、实际触摸硬件和物理输入到显示延迟仍未验证；Chromium 触摸注入不等于触摸设备实测。原生菜单自动化仍覆盖 handler/checkbox 边界，不能替代逐平台真实菜单展开检查。


## 第二阶段完善：紧凑机身与桌面时钟（2026-11-09）

最终 TypeScript typecheck/build/macOS package:dir 退出 0；Vitest **41 passed / 17 files**；普通 Electron E2E **7 passed / 6 skipped**，显式目录包/CLI smoke **1 passed**。目录包额外验证时钟菜单进入、置顶、运行 UUID 保留与返回普通窗口。六项跳过仍为 soak、四个启动脚本、package 的显式开关；未修改后端/帧链路，本轮未重跑 soak 或原生 pytest。

真实 Electron/QEMU 验证：Tab=SELECT 与 Enter=START 在聚焦 A 按钮时仍正确，游戏中不改变焦点；既有 Space、混合来源、触摸取消、模态/blur 清理继续通过。两机型 LCD 原始 320×240、4:3，对齐不变；初始和紧凑窗口照片区域与容器边界误差小于 2 CSS px。已查看浅色、深色、Mario、Zelda 方向按下及桌面时钟的实际截图，移除旧 16px 外圈和阴影，D-pad 按下使用亮金色方向反馈。照片外侧极小的透明边缘保留，任意非机身比例的手动窗口缩放仍等比容纳。

时钟往返验证：同一 QEMU PID、runtimeSessionId、DOM Canvas 保留，帧序号继续增长；480px 紧凑窗口始终置顶；普通窗口 bounds/原有 onTop 恢复。真实最大化进入/返回后恢复最大化和已有置顶；真实全屏退出完成后再设置紧凑 bounds，返回普通几何。失焦测试使用第二个原生 BrowserWindow 夺取焦点，先确认 held mask 清零，再从仍运行的 renderer preload API 注入键盘/按钮 down 和迟到 up，desiredMask/appliedMask 保持 0；重新聚焦后新按下可用。紧凑窗口关闭正常退出宿主，使用现有保存生命周期。

审阅发现并复现两个边界问题：原生 Zoom 绕过紧凑模式（真实菜单回归），以及全屏动画等待期间运行结束仍进入紧凑模式（受控宿主事件单元回归）。禁用原生 Zoom、返回前 unmaximize，并在全屏退出后重新核验运行状态；等待有 8 秒上限。修复后回归通过，审阅复核未发现阻塞项。最初退出测试在宿主关闭后读取失效的 Playwright 进程句柄，已改为缓存 ChildProcess；应用退出码 0。

Linux/Windows 的实际窗口拖动、置顶、系统菜单、全屏和焦点仍需对应平台运行验证；本轮实测范围是 macOS Apple Silicon。桌面时钟继续运行当前固件，未实现系统时间同步或自动注入 TIME；截图的时钟画面由测试显式按 T 选择。物理输入延迟与真实触摸硬件仍未测量。


## 桌面时钟像素 1:1 与更小窗口（2026-11-09）

用户确认默认 1:1 且允许进一步缩小，进入/切换机身/菜单恢复时按源 LCD 尺寸与当前输出密度计算；手动缩放使用比例容纳，离开明确的 pixelPerfect 状态。最低约束改为 80×48 逻辑像素。2× Retina 下无机身 160×120，Zelda 366×219、Mario 364×218；主进程 scaleFactor 与 renderer devicePixelRatio 均为 2。保留运行 PID/UUID、Canvas 与帧连接。

最终 typecheck/build/macOS package:dir 退出 0；Vitest **45 passed / 18 files**；普通 UI E2E **7 passed / 6 skipped**；更新后的目录包/CLI smoke **1 passed**，额外核对时钟 pixelPerfect 状态与 320×240 输出尺寸。像素验收不仅检查 bounding rect×DPR=320×240 及像素网格起点，还临时替换 Canvas putImageData 为单像素交替黑白图案，捕获 Retina 原尺寸 PNG，以 Electron nativeImage 解码逐点比对完整 320×240；Zelda、Mario、有/无机身 **0 个像素差异**。恢复原绘制方法后继续接收实际 QEMU 帧；没有改动后端图像。早期检查复现照片 alpha 滤波导致 400 个边缘像素轻微染色，按同一像素网格裁切透明孔后全量一致。

真实窗口验证包含：有机身手动缩至默认尺寸约 65%，无机身缩到 100×75，菜单恢复 1:1、切换机身恢复 1:1、帧流持续、正常窗口恢复、最大化/全屏往返及既有焦点输入检查。已查看当前 1:1 的 Zelda 真正固件时钟截图。新的 ui.inspect.canvas 返回变换后的可见尺寸、DPR 与 pixelScale，而非 CSS 布局 clientWidth。

DPR 1/1.25/1.5/2/3/4 的目标几何由单元测试覆盖；受控 Electron 宿主事件覆盖 1:1 跨密度保持，以及手动窗口保持逻辑尺寸。边界测试复现了同一窗口保持左上角时，宽度变化会改变相邻不同 DPI 屏幕的面积归属并导致尺寸振荡；原子改变 bounds、保留中心并屏蔽中间布局事件后通过。没有实际连接不同 DPI 的第二块显示器验证。外部代码审阅尝试因任务传输为不可读 token 未完成；本轮证据来自上述测试、截图和自行检查。

1:1 是 QEMU 像素与 Chromium 输出像素对应；macOS 的缩放显示模式可能再次缩放桌面，不宣称已标定实际面板子像素。小于 1:1 会丢弃源像素，符合用户允许缩小的选择。Linux/Windows 实机、触摸硬件和物理延迟仍未验证，本轮未重跑后端 pytest/soak/四条启动脚本。

## 像素倍率菜单与显示偏好持久化（2026-11-09）

最终 typecheck、生产 build/macOS package:dir 均退出 0；Vitest **59 passed / 19 files**；普通 Electron UI E2E **9 passed / 6 skipped**（40.3s）；更新后的目录包/CLI smoke **1 passed**，包括时钟、0.5× 菜单与返回普通窗口。六项跳过仍是显式 soak、四条启动脚本、package；package 已单独运行，本轮不改后端且没有重复 soak/原生 pytest/启动脚本。

真实 Electron/QEMU 覆盖两种机型、普通/时钟、有/无机身：切换边框保持 LCD 输出尺寸，同时调整窗口；手动 0.625×、1.875× 保持，模式往返各自恢复；1×/2×/0.5× 的输出尺寸、原始 320×240 Canvas 与像素网格检查通过。单像素交替图案在 2× 完整 640×480 输出逐点复制检查为 0 差异；0.5× 使用源 2×2 交替块，在 160×120 输出逐点检查，有/无机身为 0 差异；既有 1× 完整逐像素回归继续通过。图案恢复后实际帧流继续，不改变 QEMU PID、运行 UUID 或 Canvas/MessagePort。已查看 0.5× 普通和机身时钟截图，80px 宽普通标题栏仍提供菜单/关闭；小窗口制作对话框可取消后恢复原倍率。

每个机型使用同一临时 UserData 正常退出/重启三次，核对独立倍率、边框/时钟选择、时钟实际 bounds 恢复。无 ROM 启动保留正常加载界面；Zelda 的无效 ROM 不清除时钟偏好，随后加载有效 ROM 恢复；Mario 从制作对话框保存并加载，等对话框关闭后恢复。最后手动缩放后立即退出，不等 debounce，磁盘倍率仍与实际 Canvas 一致。设置单元验证旧配置默认值、独立更新不丢语言/音频、非法因子不覆盖文件、写入失败后继续工作，以及 flush 等待写入期间新增的变更。

发现并回归三个原生边界：Electron radio 的 checked setter 不能通过逐项 false 清除，改为只选择匹配项，手动倍率选择只读“自定义”；macOS 最大化先 resize 再更新 expanded 状态，临时 4.498× 不得覆盖 4×，加入延迟确认/普通 bounds 核验及最大化、全屏真实往返；菜单操作之后制作对话框未必已到达 renderer，测试先等待真实可见状态再操作，未增加固定 sleep。退出后的 Playwright process 句柄使用提前缓存的 ChildProcess。

代码审阅提出空态跨 DPI 缩小和屏幕上沿开启边框导致标题栏离屏两个 P2，均有旧实现失败/修复后通过的单元证据，复核确认已解决。真实 UI 补验靠近工作区域上沿开关边框，像素倍率不变且标题栏仍可达；超出工作区域宽度的窗口关闭按钮限制在 controlWidth 内。复核的小意见（同 DPI 不同工作区域宽度移动）也补充 changed 发布，状态值去重保持不逐坐标输出。评审传输仍曾产生不可读 token，最终审阅者通过本地设计/代码完成范围判断并给出可读报告；不将规格审阅或三平台执行称为完成。

密度 1/1.25/1.5/2/3/4 的数学几何、混合 DPI 边界稳定、丢失显示器时位置可达、空态跨 DPI 保持 320×280 均由受控单元覆盖。真实逐像素与窗口行为实测仍仅 macOS DPR2；不同 DPI 的第二块实体显示器、Linux/Windows、真实触摸及物理端到端延迟未验证。

## 最近加载与主分支集成（2026-11-10）

移除重复 Restore 1:1 入口，统一用 Pixel Scale → 1×。File → Load Recent
保存最近十个成功配置；全套日常 UI 测试 10 项通过，6 项显式长测/发布/启动
用例按默认跳过；另外实际执行目录包 smoke 通过。新增真实 UI 用例验证成功
记录、重复置顶、缺失配置保持当前 runtime、取消、制作/时钟模式禁用、
重启无自动加载、清空不中断游戏。原有 maker 用例也验证 Save and Load 记录
与无效新配置不写历史。审查发现的 macOS ampersand 显示问题已增加回归测试。

集成保留原 master 的未跟踪 .superpowers；开发版 UserData 和生成的 out
资源清理前备份到工作区 gnw-emu-worktree-backup-20261110。主项目继续使用
新 Electron 设置与存档，旧 Python 数据保留原样。主 checkout 重新构建
QEMU/desktop，并在 worktree 删除后验证四个快捷启动脚本。Linux/Windows
菜单结构有单测；此次没有运行这两个平台的原生发行版。

集成实测结果：主目录 QEMU 重建通过，typecheck/build/package:dir 通过；
63 项单测和 10 项日常 UI 回归通过（6 项显式场景默认跳过）。删除 worktree
后，原版、dump、SD 和 SD 升级四个父目录脚本 smoke 全部通过，选择器解析
为 gnw-emu；新的主目录应用包启动 smoke 通过。首次主目录单测与 QEMU
重建并行时曾读到旧二进制而失败；等待重建完成后完整重跑通过。

## 时钟右键菜单（2026-11-10）

新增四角持续停靠、自由悬浮、边框和静音。clockDock 持久化，缩放和
切换边框仍贴角；拖动取消。负屏幕坐标与超大窗口由几何单测覆盖。
ui.contextMenu 使用同一原生菜单 handler，ui.inspect.contextMenus 读取真实
检查状态；真实 Electron 用例验证进程不变、倍率不变、静音启动/恢复、
保存失败后实时静音回滚和重启持久化。

QEMU audio-muted 使用便携主机 mixer API；WAV 音频实测验证初始静音
为零样本、同一进程取消静音恢复非零样本，再静音恢复零样本。三项
音频测试通过，QEMU 重建通过。70 项 Vitest、11 项日常 UI 回归通过，
6 项长测/启动/目录包场景按默认跳过。时钟/倍率自动化操作完成边界
现在包括设置 flush；回归中复现并修复了完成早于落盘的问题。

此前无声日志为 CoreAudio I/O Timeout，用户确认浏览器也无声，拔插
USB 耳机后均恢复。此次保留原音频后端，不重启系统音频服务。

修正后的目录包重建与实际启动 smoke 通过，应用包仍位于 desktop/release/mac-arm64/gnw-emu.app。


## 自定义按键、手柄与热键（2026-11-10）

Mario/Zelda 共享应用 controls 设置；完整官方参考图、12 个普通按键、固定气泡、分页图标、单映射详情、分段连发、二级菜单、滚动热键表格和跨页冲突提示均已实现。配置草稿通过既有 settings.json 串行原子写入提交；失败保留草稿和主进程隔离，取消恢复设备参与状态。

验证：28 个 Vitest 文件 / 103 项测试、typecheck、build、git diff --check 通过。13 项真实 Electron/QEMU E2E 通过，其中 6 项覆盖改键、重启持久化、跨机型复用、取消、保存失败、录制时中立、关闭后持键隔离、连发脉冲、精确修饰键、跨页冲突、手柄摇杆/十字键、混合输入、手柄组合、设备取消回滚、界面刷新和原生快捷键替换/删除；其余 7 项回归现有机身、倍率、时钟与制作 ROM。配置 Space 时不会额外触发焦点机身按钮，未绑定 Space 的辅助操作仍有效。

目录包构建及真实启动测试通过，验证两张完整参考图、包内改键、JSON 保存和 QEMU 输入。开发与目录包均使用临时 UserData，不修改用户存档。实际界面截图位于 out/ui-validation/controls-{zelda,mario,hotkeys}.png，按仓库惯例不提交固件画面。

独立审查修复了旧输入世代持键绕过、部分重叠手柄组合漏报、真实手柄组合来源聚合、取消设备参与、刷新窗口恢复和等待中打开配置的失效问题；原子保存完成后会发布有效配置更新，以同步重载后的设备偏好。

Chromium 实测没有已连接实体手柄。手柄验收使用确定性 Gamepad API 快照加真实 QEMU；这不代表 USB/蓝牙实体连接已测试。相同指纹设备只能按本次连接选择参与，浏览器/驱动暴露不同接口时可能需重新绑定。此次原生验收为 macOS；Windows/Linux 尚未进行实体平台测试。

主目录已整合实现提交 17da281，并重跑 103 项单测、类型检查、目录包构建与 6 项控制功能 E2E。验收等待真实“自定义按键”菜单可用后再打开，覆盖初次 ROM 的最近记录落盘完成边界。临时实现 worktree 已清理，原有 .superpowers 预览保留。

## 独立按键 / 热键设置窗口修复（2026-11-10）

设置菜单分别打开两个原生 Electron 子窗口，使用各自尺寸，参考图跟随当前机型。游戏窗口的 bounds、倍率与时钟状态在打开、取消、保存、设置 renderer 刷新 / 崩溃及主 renderer 刷新后均保持或按原有生命周期恢复。设置 renderer 的非配置 IPC 仍由 main-frame 身份和作用域校验拒绝。

截图中的固定高度录入按钮、继承普通输入样式的巨大复选框和 MetaLeft 标签已修复。详情默认不录入，主动录入直接支持 Tab/Esc，成功后保留连发 / 删除 / 冲突设置；取消录入恢复预览。页顶设备入口一致，移除内部机型切换、页面标签和全局默认连发设置；旧 default 连发以实际频率编辑，JSON 格式保持兼容。

独立审查发现同指纹设备的临时参与状态在不同 renderer reader 之间丢失，以及 Chromium 延迟 / 分批暴露手柄时保存丢失未出现的选择。现由主进程交接本次连接选择，reader 单独保留尚未出现的接口，已观察断开的接口清理选择。测试覆盖 Save、重新打开、取消、已有设备偏好优先级、初次空扫描、分批出现、即刻导出和断开后恢复默认。

最终证据：30 个 Vitest 文件 / 110 项通过；typecheck、build、git diff --check 通过。15 项真实 Electron/QEMU 回归通过，包含 8 项配置窗口用例和 7 项既有机身 / 时钟 / 制作 ROM 用例。原生窗口测试验证主窗口几何不变、两种尺寸、无内部 tabs / model selector、Tab/Esc、录入文字边界、Command 显示、原生关闭、设置 renderer 崩溃、刷新隔离和时钟模式保持。手柄参与回归同时验证复选框实际为 16×16。

实现提交 a2301bf 已整合 master。主目录重新执行 110 项单测和 typecheck，通过 package:dir 构建及 1 项显式目录包启动 / 配置保存 / QEMU 输入验收。应用位于 desktop/release/mac-arm64/gnw-emu.app。实际截图已复制到主目录 out/ui-validation/controls-detail-fixed.png、controls-zelda.png 和 controls-hotkeys.png。保留用户 .superpowers 与 KeyMapping.png。

此次仍为 macOS 原生验收，Gamepad API 使用确定性输入；没有实体手柄连接，USB / 蓝牙和 Windows / Linux 原生验收未执行。
