# gwemu Audio Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 按已批准工具链迁移设计阶段一，补齐实际PCM采样率/音调、固件供音及墙钟速度证据，按实际失败定位最小缺陷。

**Architecture:** 复用当前干净ae00b68产物和已有Native/SourceGuard，合成波形经实际DMA/SAI到WAV，真实固件只挂副本。使用现有GNW_TIMELINE/checkpoint遥测，QEMU_CLOCK_VIRTUAL与宿主monotonic分别计时，不把GNWF宿主时间戳或WAV时长当客体执行速度。不先套用legacy icount或修改实时行为。

**Tech Stack:** Python/pytest、QEMU TCG/qtest、stdlib wave、numpy频谱（独立manager环境已有）、已有timeline/checkpoint、mtools。

本计划细化既有授权设计的音频回归要求，不改变产品功能或真机操作范围。parent起点1e4f96a；源码/产物身份见manager RAM报告。当前feat/gwemu-migration工作区已隔离产品数据，沿用；临时实验目录与已有out证据目录承载副本。默认legacy，旧槽位/产物/实机不动。仅发生实证缺陷时按@systematic-debugging与@test-driven-development补修复；未被本批证明的音质/端到端扬声器延迟、其它宿主/核心、realtime=false语义、保护转换/切换默认另列缺口。

### Task 1: Native waveform acceptance

**Files:** Create `tests/test_gwemu_audio.py`; reuse `tests/test_gwemu_desktop.py` Native/configure_audio; evidence `out/gwemu-audio/`.

- [x] 写实际DMA/SAI/WAV回归：48000/24000/16000Hz主分频与NODIV/FRL=64、MCKDIV=4的48000Hz路径。输入每周期48个int16单声道正弦样本，因此预期频率分别1000/500/333.33/1000Hz，宿主WAV固定48000Hz单声道。
- [x] 配置复用已有PLL2与DMA，先关闭SAI/Stream以写循环PCM，再启用；每个qtest clock_step仅10ms，先丢300ms转换段再采700ms，避免大步进制造缺样。
- [x] 最终关闭进程后读wave完整header；验证mono/int16/48000，稳定窗口RMS>1000、FFT主峰误差<2%、有效时段非零样本比例>95%。记录频谱主峰、样本数与RMS。故意半频PCM验证频率断言拒绝，不能仅以无异常退出证明测量有效。
- [x] Run `GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" build/gnwmanager-python/bin/python -m pytest -q tests/test_gwemu_audio.py`。如失败先排除测试切片/配置/量测错误，再定位正确模型层；禁止用放宽音调误差掩盖问题。

### Task 2: Copied firmware audio and wall-clock observation

**Files:** Create `tests/test_gwemu_audio_firmware.py`; reuse profiles in `tests/test_gwemu_power_firmware.py` and SourceGuard in `harness/gnwmanager.py`; evidence `out/gwemu-audio/firmware/`.

- [x] opt-in `GNW_FIRMWARE_AUDIO_TEST=1`，参数覆盖Mario、Zelda、Flash-only Retro-Go及SD spi1/ospi。缺少本地镜像/profile明确skip；已opt-in但固定binary/manifest或mtools缺失应fail。SD复制原卡后只保留fceumm并重置CONFIG，沿用已有成功SD验收的副本准备。
- [x] 每例源hash完整前后检查，挂载参数仅指临时bank1/bank2/ext/card；固定UID/RTC配置与桌面相同。TCG、display none、实际WAV后端；允许的timeline/checkpoint环境仅本实验显式构造，禁止继承其它GNW/GWEMU变量。
- [x] 实际timeline驱动固件输入，不写强制运行状态或替代guest响应。先通过截图观察确定游戏路径；stock先用TIME完成启动引导，再GAME/A；Zelda另注册空存档，Retro-Go使用Left+GAME后菜单A；SD慢启动需更长有界观察。至少保存启动/游戏截图与3个稳定checkpoint，记录SAI rate/produced/consumed/queued/dropped/starvation及virtual_ns/vblank_count。
- [x] native由父subprocess拥有：communicate或循环poll使用不可重置完整总期限（普通90秒、SD180秒），超时terminate/kill/wait，finally完整源hash核对。checkpoint文件轮询读新增完整行时记录宿主monotonic，报告采样误差约20ms；完整退出后WAV定量读取。
- [x] 身份/功能断言：进程exit0；checkpoint递增；实际稳定PCM的去均值幅度>16超过0.5秒且AC RMS>10（拒绝DC偏置）；截图有效；稳定段采样率及数据流推进。必须检查截图/运行上下文证明具体游戏，菜单静音不能冒充游戏供音。虚拟/墙钟比、播放连续性、队列深度先按原始观测报告，只有确定相同实际场景才作速度结论；WAV backend不证明CoreAudio扬声器端延迟。
- [x] Run `GNW_FIRMWARE_AUDIO_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" build/gnwmanager-python/bin/python -m pytest -q tests/test_gwemu_audio_firmware.py`，顺序执行各profile，不得并发负载污染测量。如游戏未进入，保存截图/原始日志，修正真实输入或准确记录阻断，不从静音推断模型错误。

### Task 3: Review and closeout

**Files:** Create `docs/research/2026-11-12-gwemu-audio.md`; update `docs/desktop/gwemu-migration.md` and this plan only for实际范围；必要代码修复范围由实证决定。

- [x] Run native波形+已有mute/SAI恢复相关回归，记录命令/count/no-skip；真实固件五场景独立执行。测试设施需要独立失败注入证明期限/源保护/频谱和静音检测，失败不得残留native。
- [x] 独立审查代码和结果，核对binary完整SHA与manifest、源码clean、原10hash、原legacyPID16603及无任务native。审查可指出需要缩小成功声称的未验收游戏路径。
- [x] 若无产品/native变化不重复整套桌面GUI；若出现模型/参数修复需RED/GREEN、独立审查、干净新目录构建、相关原生/真实固件/桌面能力与GUI回归后按已授权native发布。manager不变。
- [x] 父仓库仅本地提交本批验收及实证修复（如有），排除.superpowers。报告量测能力和具体未覆盖边界，不宣称全阶段一通过或退休旧库。

关闭记录：原生/设施/静音/SAI恢复17passed1.70s；五真实固件+三设施8passed184.60s，无skip；独立设施复验5passed0.94s。最终aggregate APPROVED，见out/gwemu-audio/final-review.txt；十源hash、固定artifact、两源码clean及无任务native通过。范围仅PCM/WAV，默认legacy及阶段一其余退出门槛保留。
