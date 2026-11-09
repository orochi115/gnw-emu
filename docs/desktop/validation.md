# 第一阶段验证记录

环境：macOS 15.6，Apple Silicon，Node24.8.0、Electron39.8.10，QEMU11.1.3原生arm64。截图/测量在未跟踪out/ui-validation。

最终验证（2026-11-09）：TypeScript typecheck、生产 build、macOS package:dir 均退出 0；Vitest **26 passed / 12 files**；普通 Electron E2E **3 passed / 2 skipped**（十分钟与目录包为显式启用测试），二者另行执行均 **1 passed**；原生 pytest 全量 **33 passed / 7 skipped**。跳过的是缺少额外固件/SD测试镜像的场景，不是缺少QEMU构建。目录包验证同时通过 Node ui-cli 连接运行中应用执行 capabilities、ui.inspect、logging.getConfig/tail；probe.sh 输出隔离寄存器与图像。shell语法检查和git diff --check通过。

已执行：真实QEMU帧握手/ACK/非法控制、背光、退出JSON、OS锁；JSON存档副本隔离、配置身份、日志级别/过滤/错误cause、有界recent cursor；真实QMP请求匹配；默认按键短按/组合键/失焦释放；完整启动/无效新ROM保留旧运行/退出保存；独立Playwright原生菜单及表单；JSON-RPC实际填表、系统保存取消替代、保存并加载、Canvas有效像素、源镜像SHA256不变；macOS目录包内置QEMU/依赖/automation启动。

声音：QEMU WAV宿主backend接收到非零双声道PCM，原有SAI波形无buffer seam回归通过；设备不可用不会在每个DMA半缓冲重试。宿主实际扬声器音量/音质仍需人工听音确认，文件捕获测试不能代替听音。

视觉：已实际查看640×480 CSS区域、Retina2x截图的浅色空态、制作表单和游戏画面，原生窗口控制保持系统行为。深色、380px窄窗口、错误、长路径和首个无效字段聚焦也已通过E2E并查看截图。制作表单有内部滚动区及始终可见的底部操作，游戏整数缩放并居中黑边。截图是窗口内容截图，不包含系统菜单栏。

性能：十分钟真实Electron/QEMU运行通过：61个样本，主进程RSS159.5–166.2MiB、结束161MiB，无持续增长；观测队列最多1帧、消费等待丢弃0；Canvas平均61.02次绘制/秒（36613次/600秒）。该场景为原厂游戏，非慢消费压力场景；慢消费另有单元背压测试。帧序号增长/Canvas绘制次数不等于60Hz有效画面变化；QMP成功不是输入到画面延迟。未进行真实物理显示器/输入延迟标定，因此不得声明达到稳定60Hz有效更新或特定端到端低延迟。

平台：macOS开发版和目录包运行已验证；Linux/Windows架构、路径、打包及Windows锁实现已预留，但没有这些执行环境，原生构建/目录包/系统菜单/声音/锁的实际运行均**未验证**。不能把macOS测试结果当成三平台完成证据。

需人工补验：每个平台真实系统文件对话框（测试替代只检验下游逻辑）、菜单展开及键盘焦点、强制退出警告、声卡选择/声音。自动化原生菜单操作仅覆盖Menu handler边界。
