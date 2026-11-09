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
