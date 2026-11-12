# CoreAudio 独立进程音频流共存验收

> 执行既有迁移设计的阶段一音频回归；按 systematic-debugging 先验证假设，再决定是否修复。

**目标：** 在另一自有 CoreAudio 输出进程持续运行时，验证 gwemu 启动、暂停/继续、静音、音频重建、读档恢复和关闭。

**边界：** 父起点 ee692cb，沿用 feat/gwemu-migration；legacy 默认不变。固定 native ae00b68951ab44b0dffb265e3f61340d735a68e5 与 manager 7a82d653f23b5e3b5802eb4ce1e5076f94aa379b。不动原十镜像、产品 UserData/session/存档、旁 manager、用户 .superpowers、原 legacy PID16603。测试挂载临时合成副本，只回收自有进程。

## 调查修正

初始计划怀疑 coreaudio.m 的 DeviceIsRunning 检查会被其它应用影响。首次实际实验在 gwemu 启动前失败：peer 回调推进，独立查询进程却读到 running=0。这是测试前提错误，不能作为原生缺陷 RED。SDK AudioHardware.h 明确 DeviceIsRunningSomewhere 表示至少一个系统进程正在运行该设备。增加只读 telemetry 后，peer 自己的 running=1、独立查询 running=0/runningSomewhere=1，与回调证据一致。

撤回以“全局 DeviceIsRunning”构造 HAL stub RED 和预设原生修复的步骤。只有正确实测复现产品缺陷后才重新制定修复计划。本轮正确共存实测通过，因此不修改/重建/发布 native，不更换桌面产物绑定。

## 验收步骤

- [x] 审查条件复现计划；发现前提错误后依据 SDK 和实际进程读回纠正。
- [x] 自有静音 peer 注册并无条件启动自己的 IOProc；回调只清零自己的输出和原子计数，不读取输入或混音，不设置设备、音量或默认输出。主线程 stats/quit JSON，SIGTERM/EOF/60秒截止清理自己的 IOProc。
- [x] Python 采用 select/os.read 和总截止，部分行也不能无限等待。启动前 peer 至少两次回调、自身 running=1、独立查询 runningSomewhere=1、设备身份和配置一致。保留 peer/native PID、参数、构建身份、即时日志与相位证据。
- [x] 固定旧产物真实 TCG 七相位验收：1kHz、暂停、继续、静音、解除静音、24kHz voice 的500Hz、恢复48kHz存档的1kHz。转换后300ms不计，约850ms稳定窗口检查实际输出回调PCM；每相位 peer 回调增加，native关闭后peer继续。外部45秒监督，所有IPC/退出有界。
- [x] 纯设施及完整 Native/capture 相关回归；未改产品/native/manager，不重复无关完整GUI/固件回归。普通无peer合成正对照沿用上批独立通过的原始证据。
- [x] 十源hash、固定产物/子模块/旁manager和owned进程最终审计；独立审查报告与原始证据。
- [x] 只本地提交 tests/docs，不推父仓库；无native发布，无默认切换。

实际执行：

```sh
.venv/bin/python -m pytest -q tests/test_gwemu_coreaudio_shared.py tests/test_gwemu_coreaudio.py -k 'not actual'
.venv/bin/python -m pytest -q tests/test_gwemu_desktop.py tests/test_gwemu_audio_firmware.py
# 在沙箱外，监督器固定 GWEMU_BINARY 与 GNW_COREAUDIO_TEST=1
.venv/bin/python out/gwemu-coreaudio-sharing/run-shared.py
.venv/bin/python out/gwemu-coreaudio-sharing/audit.py
```

独立重跑实际用例可用 GNW_COREAUDIO_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_coreaudio_shared.py -k actual。监督器与原始证据留在 ignored out/。

未覆盖：任意第三方应用、同进程多个独立IOProc、设备切换、其它输出设备、宿主重负载、声学音质/端到端延迟和实体手柄；不能据本轮宣称所有阶段一退出条件完成。
