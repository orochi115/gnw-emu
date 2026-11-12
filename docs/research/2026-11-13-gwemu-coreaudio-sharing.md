# gwemu CoreAudio 独立输出流共存验收

固定既有 gwemu 产物在另一自有 CoreAudio 输出进程持续运行时通过七相位验收。本批增加测试和只读诊断，没有复现原生缺陷；不修改产品、native 或 manager，不重新构建或发布 native，默认仍为 legacy。

## 来源与错误前提的纠正

父起点 ee692cb，分支 feat/gwemu-migration。native 为 ae00b68951ab44b0dffb265e3f61340d735a68e5，build/gwemu-manager-ram/qemu-system-arm SHA256 69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a；manager 7a82d653f23b5e3b5802eb4ce1e5076f94aa379b。使用桌面默认 coreaudio,id=snd0、普通 TCG、无 icount 或虚拟时间操纵，挂载临时合成镜像。

初始源码假设将 kAudioDevicePropertyDeviceIsRunning 当作跨进程状态。首次实验 run-8oc9po9i 的 peer 已有回调，独立查询仍为0，测试在 gwemu 启动前失败；nativeReturncode=null，不是后端缺陷 RED。保留原始失败，不据此制造 stub RED 或修改 native。

macOS SDK AudioHardware.h 的 DeviceIsRunningSomewhere 注释明确表示设备在至少一个系统进程中运行。测试改为读取该属性，并在 peer 主线程读取自身 DeviceIsRunning。实际 peer 自己 running=1、独立查询 running=0/runningSomewhere=1，回调持续增加；这是当前宿主上进程范围差异的直接证据。原生仍使用普通 DeviceIsRunning，本轮独立应用流不会令它跳过自身启动。不能从此推断同一进程内任意多IOProc组合。

## 观测与结果

自有 peer 只清零自己的输出缓冲；不采集麦克风、输入或系统混音，不设置设备属性、音量或默认设备。已有被动 observer 仅注入自有 gwemu，记录原 IOProc 返回后的输出 PCM。新加入的设备查询属性仅在 PROBE_TOOL 路径执行，回调代码不变。peer 属性查询在主线程执行。

最终原始证据 out/gwemu-coreaudio-sharing/actual/run-ukxhn2kx/，包含 acceptance.json、callbacks.bin、peer.json、native.log 和 peer.log。记录 peer 编译命令/源码及产物SHA、observer源码/dylibSHA、两个PID及native参数。native PID85440，peer PID85438；外部监督worker见 supervision.json。较早纠正前提后的 run-f6aijq7f 也通过；最终运行补齐peer构建身份与共存时设备配置检查。

每次转换后留300ms，检查约850ms稳定窗口：

| 相位 | gwemu回调数 | 供音结果 | peer回调前→后 |
|---|---:|---|---|
| 启动 | 74 | 999.839Hz | 42→142 |
| 暂停 | 0 | 无回调，单独记录 | 142→241 |
| 继续 | 74 | 999.839Hz | 242→342 |
| 静音 | 74 | 双声道绝对RMS=0 | 342→442 |
| 解除静音 | 73 | 1000.557Hz | 442→541 |
| 重建为24kHz voice | 73 | 500.278Hz | 544→643 |
| 恢复48kHz存档 | 74 | 999.839Hz | 645→745 |

全部有效供音窗口至少0.5秒、去DC RMS>0.01、频率误差<2%；双声道一致。静音检查实际零PCM，暂停检查没有回调；缺失整份trace不可作为通过。共594次回调，两个IOProc全部销毁，Start/Stop各4次，无溢出/注册或生命周期错误。native正常exit0、日志无CoreAudio错误，关闭后peer回调745→754，再只Stop/Destroy自身IOProc，状态均0。

设备前、共存中、后均为ID76、44100Hz、Float32双声道、512frames（范围14..4096），格式flags9、32bits；配置不变。runningSomewhere前后为0、共存中为1，这些运行状态不是配置字段。前置配置已匹配QEMU默认值，无需调整设备。

## 验证与范围

真实最终用例1 passed / 9.53s，无超时或skip；纯设施12 passed / 0.86s，7项实际opt-in用例deselected。Native/capture相关回归16 passed / 2.02s，5项既有WAV固件用例按opt-in明确skip，它们在先前批次已单独验收。本批普通无peer对照沿用 [上批合成与五游戏证据](2026-11-12-gwemu-coreaudio.md)，未改回调/产品后端，无需重复完整游戏/GUI回归。

```sh
.venv/bin/python -m pytest -q tests/test_gwemu_coreaudio_shared.py tests/test_gwemu_coreaudio.py -k 'not actual'
.venv/bin/python -m pytest -q tests/test_gwemu_desktop.py tests/test_gwemu_audio_firmware.py
# 沙箱外，45秒外部监督；固定产物、GNW_COREAUDIO_TEST=1
.venv/bin/python out/gwemu-coreaudio-sharing/run-shared.py
.venv/bin/python out/gwemu-coreaudio-sharing/audit.py
```

peer的JSON读取有总截止，部分行也超时；对应负例通过。peer收到quit、EOF或SIGTERM时清理自己的IOProc，60秒自截止；父端有界TERM/KILL/reap。外部监督仅终止该worker新建进程组，原legacy PID16603保留。原十镜像大小/SHA与固定产物已再次核对；两子模块和旁manager干净、身份不变。产品UserData/session/历史states、用户.superpowers与真机不动。

本轮证明当前内置扬声器上的独立CoreAudio输出流共存和gwemu稳定窗口供音，不证明任意第三方应用组合、同进程多IOProc、其它设备/热插拔、宿主重负载、声学音质或端到端延迟。实体手柄和全部迁移退出条件仍未完成。

独立最终审查 APPROVED，无阻断问题（out/gwemu-coreaudio-sharing/final-review.txt）。审查者独立运行12项设施、16项Native/capture，重新解析七相位PCM并逐项核对统计、生命周期、源哈希和进程。pytest保留策略已清除该场临时peer/observer二进制，历史二进制SHA不能事后重算；原编译命令、源码SHA、当场记录的二进制SHA和原始捕获保留，源码与native产物SHA已独立重算。父仓库仅本地提交，不推送。
