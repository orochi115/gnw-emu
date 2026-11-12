# gwemu CoreAudio 实际输出回调验收

日期：2026-11-13（计划始于 11-12）。本批验证 macOS 内置扬声器的实际 CoreAudio IOProc 输出缓冲，不使用 WAV 代替宿主后端。合成音调、静音、暂停/继续和即时存档音频恢复，以及 Mario/Zelda OFW、Flash Retro-Go、SD Retro-Go 两种接线的游戏供音均通过。本批只有测试设施与文档改动；不修改产品、原生模型或 manager，默认仍为 legacy，阶段一全部退出条件尚未通过。

## 来源与观测边界

父起点 `1568e2d139753462a7e96dbf08ac5131b3cf964b`，沿用 `feat/gwemu-migration`。native 固定 `ae00b68951ab44b0dffb265e3f61340d735a68e5`，产物 `build/gwemu-manager-ram/qemu-system-arm` SHA256 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`，来源 manifest 保持不变；manager 仍为 `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b`。

`tests/fixtures/coreaudio_probe.c` 是测试专用 DYLD interpose observer，仅注入本轮所拥有的 gwemu 子进程。它转发原 AudioDeviceIOProc 一次，保留 client、参数、返回值和缓冲内容，在原回调返回后复制输出 Float32 PCM 与宿主 monotonic 时间。观察器不修改输出、不采集麦克风、不读取其他应用或全系统混音。所有回调存储预分配、预触页、原子有界预约；回调内不分配、写文件或查询 HAL 属性。context 在 voice 重开后保留至进程退出；正常销毁所有已注册 IOProc 后才接受退出 trace。溢出、注册失败、未销毁、缺失/截断/空回调及非有限 PCM 均拒绝，不把“没有观察器输出”当作静音成功。

这层证据证明 QEMU 向真实输出设备回调提交了正确 PCM，不证明扬声器声学输出、系统音量、听感、客体输入到扬声器的端到端延迟或所有核心表现。探针复制本身增加少量回调工作；记录的 callback 间隔不等于可听中断或声学延迟。本批没有启动另一条并发音频流，没有验收其它输出设备、设备切换或宿主重负载。

沙箱内 HAL 不可见；真实播放均在沙箱外运行。设备前置检查要求默认输出已经匹配桌面的普通 `coreaudio,id=snd0` 参数，避免让 QEMU 初始化改动现有配置。实际设备 ID76、44100Hz、Float32 双声道、512 帧（范围14..4096），前后配置相同。未调整音量或切换默认设备。guest 为 OFW48003Hz、Retro-Go48000Hz，宿主44100Hz，分别验证而非混为同一采样率。

## 合成相位

最终证据 `out/gwemu-coreaudio/synthetic/run-xnot5xtl/`，正常退出 native，临时合成镜像，普通 TCG、无 icount/无 qtest 时间操纵。circular DMA 中写入960个正弦样本；每次转换留300ms后取约850ms回调区间。

| 相位 | 回调数 | 结果 |
|---|---:|---|
| 48kHz/1kHz 音调 | 73 | 1000.557Hz，去DC RMS约0.259 |
| 静音 | 74 | PCM RMS=0，回调仍推进 |
| 解除静音 | 73 | 1000.557Hz |
| 暂停 | 0 | 没有回调，单独记录，未伪造零PCM |
| 继续 | 73 | 1000.557Hz |
| 未来24kHz状态 | 74 | 500.501Hz |
| 回退到48kHz存档 | 74 | 999.839Hz |

在停机状态保存48kHz，运行未来的24kHz，再停机读档。最后的稳定窗口恢复1kHz，未来的500Hz配置没有持续进入恢复后的稳定供音；转换后前300ms不在本批断言窗口内。至少0.5秒稳定输出、RMS>0.01、主频误差<2%等门槛分别检查；静音门槛为绝对RMS≤1e-6。没有将marker间隔称作客体到扬声器延迟。设备初始化、暂停/恢复日志没有 CoreAudio 错误。左右声道逐样本一致；静音绝对RMS检查覆盖两个声道，另有只在右声道泄漏声音的负例。五固件的最终双声道检查直接重解析原始trace通过，未重跑无变化的固件。

## 五组实际游戏

镜像和 SD 全部复制到独立临时 session；沿用已验收 WAV 批次的正常游戏输入 timeline，没有更改按钮时刻来迁就结果。SD 仅在副本固定 NES core/配置；原镜像由 SourceGuard 在成功/异常退出后复核。实际父 monotonic 原点与 checkpoint 收取时间形成约8秒稳定窗口，并各留100ms内边距；收取包含轮询/调度误差，未声称注入时刻的精确端到端延迟。

| 游戏场景 | 稳定回调数 | PCM秒 | 去DC RMS | 超阈值样本秒 |
|---|---:|---:|---:|---:|
| Mario OFW | 672 | 7.802 | 0.08366 | 7.751 |
| Zelda OFW | 672 | 7.802 | 0.04829 | 7.745 |
| Flash Retro-Go / BattleCity | 672 | 7.802 | 0.02329 | 7.801 |
| SD SPI1 / Kage | 671 | 7.790 | 0.01133 | 7.447 |
| SD OSPI / Kage | 672 | 7.802 | 0.01143 | 7.437 |

逐一检查最终截图：Mario1-1关卡、Zelda地面场景、BattleCity坦克/砖墙及两种接线的Kage关卡，均非启动或角色选择面板。三个checkpoint的SAI生产/消费持续递增，最终 `dropped_bytes=0`；稳定窗口最大回调间隔约11.73..11.87ms，名义512/44100约11.61ms。`starvation_callbacks` 仍只表示可用容量未完全填满，不能据此推断声音断续时长。统计和游戏截图保存于各独立 `out/gwemu-coreaudio/firmware/<name>/run-*/`；观察器源码/dylib SHA和编译命令也保存，首轮固件身份记录由同一pytest session构建manifest补注并保留说明。

## 验证与安全

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  .venv/bin/python -m pytest -q tests/test_gwemu_coreaudio.py -k 'not actual'
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  .venv/bin/python -m pytest -q tests/test_gwemu_desktop.py tests/test_gwemu_audio_firmware.py
GNW_COREAUDIO_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  .venv/bin/python -m pytest -q tests/test_gwemu_coreaudio.py -k actual
```

合成最终1 passed / 9.28s；五固件5 passed / 185.11s、无skip。纯设施11 passed / 0.86s；完整Native/capture回归16 passed / 1.97s，另5项是既有 opt-in WAV固件用例在该命令中明确skip，它们此前已单独完成，本批未重复WAV捕获。设施覆盖原回调/client/status/PCM不变、overflow仍转发、截断/缺失/空/NaN、静音/DC/错误音高拒绝。编译使用 `-std=c11 -Wall -Wextra -Werror`；无生产修复，不制造假RED/GREEN。

Native测试夹具只增加显式子进程environment注入、可选即时stderr文件和退出记录，默认GNW_/GWEMU_清理保持；固件capture只增加真实 `startedHostNs` 与启动时 `process.json` 证据。合成外部截止45秒，固件每场原生截止90/180秒且进度不续期，外部worker另有进程组监督。启动与各相位状态即时原子保存，stderr直接落盘，超时强杀也保留此前完整证据；设备查询失败记录错误而不丢掉实验信息。所有实验只回收自己的native/worker，原legacy PID16603保留。

十个原镜像大小/SHA、产物与两子模块及旁manager身份在关闭前独立核对。用户 `.superpowers/`、产品UserData/session/历史存档和实机未修改；没有native/manager发布。CoreAudio回调验收通过不等于声学音质/延迟或全部迁移完成；实体手柄及其它阶段一条件、阶段二备份和阶段三会话保护继续按原设计推进。

最终独立审查及日志补充审查均 APPROVED，无阻断问题（`out/gwemu-coreaudio/final-review.txt`）。独立设施/Native/capture26项通过，并复核六份原始捕获、五组游戏截图、源镜像和产物/进程身份；另外以自有无设备子进程注入启动失败和Popen失败，验证日志保留、句柄关闭及重复清理。父仓库只本地提交本批测试与文档。
