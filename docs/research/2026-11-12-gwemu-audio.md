# gwemu PCM 与游戏供音验收

本批为迁移阶段一补充 DMA→SAI→WAV 的音调和五组复制固件的游戏供音证据。没有修改产品、原生模型或 manager；桌面默认仍为 legacy。四种合成波形音调与五组实际游戏供音通过本批门槛；本报告只关闭 PCM/WAV 层的验收范围。

## 来源与运行环境

- 原生源码固定 `ae00b68951ab44b0dffb265e3f61340d735a68e5`，源码干净；沿用 RAM 管理固件批次的独立构建。
- 可执行文件 `build/gwemu-manager-ram/qemu-system-arm`，SHA-256 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`。
- manifest：`build/gwemu-manager-ram/gnw-build-manifest.json`；QEMU 11.0.2 / gwemu v0.0.29-12-gae00b68，Darwin arm64 24.6.0，Apple clang 17.0.0。
- 测试使用独立 `build/gnwmanager-python/bin/python`：Python 3.13.18、NumPy 2.5.4、Pillow 11.3.0、pytest；SD 副本准备另需 mtools。系统扬声器后端未参与本批测量。

## 测量方法

`tests/test_gwemu_audio.py` 通过实际 DMA/SAI 写出周期为 48 个样本的 int16 正弦波。客体主分频产生 48000/24000/16000 Hz，并另测 NODIV、FRL=64、MCKDIV=4 的 48000 Hz 路径；宿主 WAV 均为 48000 Hz、单声道、16 bit。每次 qtest 步进 10 ms，丢弃最初 300 ms，观察其后约 700 ms。检查 AC RMS、非零比例和 FFT 主峰；独立负例确认半频和静音无法通过。

`tests/test_gwemu_audio_firmware.py` opt-in 后仅挂载新的镜像/SD 副本，固定 UID、RTC 与供电配置，以正常 TCG 运行真实固件。每次创建独立证据目录，避免旧截图冒充当前结果。原镜像全量 SHA 在成功和异常退出后都复核。每个 native 由父进程拥有，完整总期限为普通固件 90 秒、SD 180 秒；持续 checkpoint 不续期，超时 terminate/kill/wait。所有场景顺序执行。

按实际按钮进入游戏后，在相隔约四秒的三个 checkpoint 记录 `QEMU_CLOCK_VIRTUAL`、宿主 monotonic、SAI 遥测和 WAV 文件字节位置。进程正常退出后验证 WAV 格式与 44-byte PCM header，用 checkpoint 字节位置截取约八秒稳定段。稳定段须超过 0.5 秒的去均值幅度大于 16 的样本，且 AC RMS 大于 10；还检查每段虚拟/墙钟与 SAI 生产/消费递增、客体配置采样率为 OFW 的 48003 Hz / Retro-Go 的 48000 Hz（宿主 WAV 均为 48000 Hz）。该门槛证明存在供音，不能证明主观音质或每一瞬间连续播放。

独立设施负例覆盖：持续进度且忽略 TERM 的子进程仍超时并被回收；旧 `game.png` 无法满足新捕获；2-LSB 非零直流不能冒充声音。复用的 SourceGuard 另有实验失败时发现源变动的负例。

## 合成波形结果

| 客体路径 | 预期主峰 Hz | 实测主峰 Hz | AC RMS | 非零比例 |
|---|---:|---:|---:|---:|
| MCKDIV=1，48000 Hz | 1000 | 999.54 | 16971.65 | 95.84% |
| MCKDIV=2，24000 Hz | 500 | 499.51 | 16949.95 | 97.92% |
| MCKDIV=3，16000 Hz | 333.33 | 333.64 | 16952.13 | 98.61% |
| NODIV，FRL=64，MCKDIV=4 | 1000 | 999.54 | 16971.65 | 95.84% |

全部频率误差小于 0.1%，低于 2% 门槛。非零比例包含正弦的真实零交叉，不能逐个零样本解释为丢音。原始统计位于 `out/gwemu-audio/tone-*.json`。

## 实际游戏路径与诊断

- Mario 先按 TIME 完成启动引导，再 GAME/A，截图确认 Super Mario Bros. World 1-1。
- Zelda 先完成 TIME 引导，再通过真实 START/A 注册并确认空存档，进入 The Legend of Zelda 地图。
- Flash-only Retro-Go 用 Left+GAME 进入启动器，A 恢复 Battle City。恢复后再发 START 会暂停 NES；夹具已删除这次多余输入，稳定观测窗和声音门槛不变。
- SD SPI1/OSPI 均使用原卡副本，只保留 fceumm core 并删除副本 CONFIG，启动 Kage。OSPI 加载较慢，早期固定 START 停在角色选择页；统一在虚拟 30/34 秒操作标题和角色选择，另保存两页截图，之后观察实际关卡。

早期失败 WAV、截图、日志均保留在 `out/gwemu-audio/`。菜单静音、开机提示音乐及直流偏置不计为游戏供音通过；这些失败没有建立原生音频模型缺陷。增强断言时曾误把客体采样率统一写成 48000 Hz，导致两组 OFW 失败；原始 checkpoint 明确为 48003 Hz，已按实际 PLL 解码结果区分客体与宿主采样率，失败记录保留于 `firmware-final.log`。

## 五组最终捕获结果

| 场景 | 客体 Hz | 稳定 WAV 秒 | 幅度过门槛秒 | AC RMS | 虚拟/墙钟 |
|---|---:|---:|---:|---:|---:|
| mario | 48003 | 8.021 | 8.011 | 5396.81 | 0.99908 |
| zelda | 48003 | 7.979 | 7.958 | 3174.11 | 1.00035 |
| flash-retrogo | 48000 | 7.979 | 7.979 | 1528.29 | 0.99933 |
| sd-spi1 | 48000 | 7.979 | 7.816 | 750.55 | 0.99992 |
| sd-ospi | 48000 | 7.979 | 7.802 | 749.81 | 0.99929 |

各场景虚拟观察段约八秒。这里的“幅度过门槛秒”是去均值绝对幅度大于 16 的样本数除以 48000，并非听感连续时间。

| 场景 | 三点队列 bytes | 生产增量 bytes | 消费增量 bytes | starvation 增量 | dropped 增量 bytes |
|---|---:|---:|---:|---:|---:|
| mario | 240/240/480 | 768000 | 767760 | 796 | 0 |
| zelda | 480/720/720 | 768000 | 767760 | 796 | 0 |
| flash-retrogo | 0/1600/1600 | 768000 | 766400 | 796 | 0 |
| sd-spi1 | 1600/1600/0 | 768000 | 769600 | 797 | 0 |
| sd-ospi | 0/0/0 | 768000 | 768000 | 796 | 0 |

本轮检查点 dropped 累计值也全部为零；starvation 的解释见量测边界。最终证据目录：

- `mario/run-l89cc9th`
- `zelda/run-qx7nyeib`
- `flash-retrogo/run-sekfgc4u`
- `sd-spi1/run-7olua391`
- `sd-ospi/run-h03_kcx6`

最终 opt-in 完整日志：`8 passed in 184.60s (0:03:04)`，五固件和三设施负例全部执行，无跳过。根代理与独立审查分别核对实际游戏画面。

## 复验命令

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  build/gnwmanager-python/bin/python -m pytest -q \
  tests/test_gwemu_audio.py tests/test_gwemu_audio_firmware.py \
  tests/test_gwemu_desktop.py tests/test_gwemu_savestate_runtime.py \
  tests/test_gwemu_manager.py -k 'audio or mute or sai or source_guard'

GNW_FIRMWARE_AUDIO_TEST=1 \
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  build/gnwmanager-python/bin/python -m pytest -q tests/test_gwemu_audio_firmware.py
```

第一条已获得 17 passed、5 个未 opt-in 固件场景明确 skipped、50 deselected（1.70 秒）；第二条已单独覆盖这五个场景及三个设施负例。结果日志分别为 `out/gwemu-audio/native-final.log` 与 `firmware-final-fixed.log`。每场景证据目录由 `out/gwemu-audio/firmware/<profile>/active-run.txt` 定位，含原始 WAV、截图、timeline、native log、checkpoint 与 `acceptance.json`；历史 run 不覆盖。

## 量测边界与剩余工作

宿主 checkpoint 轮询间隔约 20 ms，含进程调度误差。WAV 文件按后端缓冲批次增长，字节窗口与虚拟八秒边界存在量化误差，不将两者视为样本精确对齐。虚拟/墙钟比只描述本机、此后端、此场景的时间推进，不是游戏 CPU 性能或游戏帧率。

SAI `starvation_callbacks` 表示某次回调的可用容量没有全部填满，不能直接换算成听到的中断次数/时长。`dropped_bytes` 和队列深度原样报告，不把 WAV 后端队列当 CoreAudio 扬声器延迟。display none 下 checkpoint 的 console surface SHA 可能未刷新；画面判断使用实际 screendump PNG，`vblank_count` 也不等于新游戏帧数。

本批不验收 CoreAudio 端到端延迟、主观音质、所有 Retro-Go core、其它宿主或完整游戏流程。当前 gwemu 参数构造尚未映射已有 `realtime=false` 偏好；本批不修改限速策略，也不先套用 legacy icount。音频产品验收、手柄以及其余阶段一退出项仍须逐项核对；备份迁移、当前会话入口和保护转换另按原迁移设计推进。

## 最终安全核对

十个原镜像全量大小/SHA-256 与 RAM 批次基线一致；native 与 manager 子模块均干净，固定 revision 和实际二进制 SHA 与 manifest 一致。旁边原 `../gnwmanager` 保留原 revision。进程审计只见原 legacy PID16603，无本批实验 native。证据为 `out/gwemu-audio/source-final.json`、`process-final.json` 和 `resume.json`。本批不涉及真实设备或源固件驱动变更，也不需要新 native/manager 发布；父仓库仅本地提交。

最终独立审查 **APPROVED**（`out/gwemu-audio/final-review.txt`），独立五个设施/保护负例另通过 0.94 秒。批准范围仅 PCM/WAV 与本地测试/文档提交，不代表阶段一全通过。
