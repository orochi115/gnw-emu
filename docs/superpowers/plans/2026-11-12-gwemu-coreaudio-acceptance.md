# gwemu CoreAudio Callback Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task.

**Goal:** 验收 macOS 真实 CoreAudio 输出回调中的 PCM，补齐既有 WAV 证据没有覆盖的宿主播放边界。

**Architecture:** 细化已批准迁移设计的音频验收，不改产品/native。测试专用 DYLD interpose observer 只注入本轮拥有的 gwemu 子进程，在真实 AudioDeviceIOProc 原回调执行后被动复制输出 PCM。callback 不分配/写磁盘/查询 CoreAudio 属性/更改音频缓冲；预分配有界内存，退出后落盘，记录溢出及注册失败。不能采集麦克风、其它进程或全系统混音。沿用迁移分支及固定产物，独立临时 session，默认 legacy、父提交只本地。

**Tech Stack:** macOS CoreAudio、C/Clang dylib、Python/pytest/NumPy、现有 Native/backed、copied firmware timeline。

备选只看 SAI consumed_bytes（不足以证明设备回调内容）或录制系统 loopback/麦克风（超出本轮范围）。选择实际回调被动观察，可证明提交给默认输出设备的波形、静音及恢复；不能证明扬声器声学延迟/实际可听响度/主观音质/所有核心。本机沙箱内没有设备可见性，所有真实 CoreAudio 运行使用沙箱外执行；只读 system_profiler 已确认默认内置双声道扬声器 44100Hz。不切换默认设备、不调整系统音量、不安装驱动，不停止原 PID16603。观察器主动查询并记录前后输出设备配置；测试使用桌面实际 `coreaudio,id=snd0` 默认选项，不覆盖采样率。若配置改变，先查明原生后端行为，明确报告，不能默默覆盖其它进程设置。

### Task 1: Bounded passive observer

**Files:** Create `tests/fixtures/coreaudio_probe.c`; Create `tests/test_gwemu_coreaudio.py` 的构建、二进制解析、设施测试；修改 `tests/test_gwemu_desktop.py`，增加仅子进程 environment 注入、可选即时 stderr 文件及退出证据，不改默认 GNW_/GWEMU_ 清理。

- [x] Observer 被动 interpose AudioDeviceCreateIOProcID，并原样转发 DestroyIOProcID/Start/Stop 来计数生命周期，将原 callback 与 client 指针存于有界生命周期 context，确保原回调每次恰好调用一次且返回值/缓冲内容不变。多个 voice 重开使用独立 context，不在仍有回调时复用/释放；所有内存预分配，实际并发追加需原子有界预约。每条记录包含 host monotonic ns、voice ID、rate/format/channels/byte count/原 OSStatus、原样 Float32 输出数据；文件头含版本/记录长度/截断及注册计数。采样率等在注册前正常线程查询，不在 callback 内查询。退出时落盘，无效配置、超额voice、容量不足或未加载 observer 均须被测试明确拒绝。
- [x] 同一 C 文件提供 compile-time selftest/tool 模式，selftest 用已知 fake callback 填数值并返回指定错误码，确认 client/次数/输出/返回值保持以及记录器边界溢出行为。tool 只查询默认输出设备配置，绝不写属性。解析器拒绝缺文件、空回调、错格式/通道、不完整头/payload、overflow和非有限浮点值。设施负例含 silent/DC/wrong-pitch/malformed/overflow，先确认失败再完成最小测试设施。
- [x] 编译 `cc -std=c11 -Wall -Wextra -Werror -dynamiclib -framework CoreAudio ...`，记录源码/dylib SHA 与构建参数。纯设施 `pytest -q tests/test_gwemu_coreaudio.py -k 'not actual'` 无真实设备依赖。

### Task 2: Actual CoreAudio synthetic phases

**Files:** Extend `tests/test_gwemu_coreaudio.py`。

- [x] 明确 macOS opt-in `GNW_COREAUDIO_TEST=1`；缺本地原生产物/真实设备时 fail 而非误记通过。固定 manifest/artifact 核对。通过测试专用 Native subclass 只在自身 subprocess env 添加 DYLD_INSERT_LIBRARIES 与观察器绝对输出路径；不修改父环境，不在产品设置保存。
- [x] 合成临时镜像，TCG 无 icount，无 qtest 时间操纵。用 configure_audio + 960sample 1kHz@48kHz 正弦填 circular DMA；记录 actual callback PCM 的主频误差<2%、去均值RMS>0.01、至少0.5秒稳定输出及实际设备采样率。保持桌面 CoreAudio 默认参数（预期宿主44100Hz、guest48000），分别量测 unmuted→muted→unmuted→paused→resume→saved48k→改成24k/500Hz→load48k/1kHz。转换后留300ms排空队列，再量测>=0.7s，静音<=1e-6 RMS；pause 稳定区间不允许非零输出，无回调期间单独记录不能伪造PCM静音；检查稳定期音调恢复；转换后前300ms的瞬态与硬件队列/声学延迟不在本批断言内。
- [x] 所有 phase 使用宿主 monotonic markers，与 callback hostNs 同时钟检查；实际 voice 注册和回调进展必须非零、均正常返回。只报告 software-submit 观察，不称这些marker为客体到扬声器延迟。退出必须正常，native日志无 CoreAudio 初始化/暂停/恢复错误。
- [x] 复用有界 QMP/native退出，外部整个合成实验45秒监督，进程组仅本测试，超时TERM/KILL/reap；即使失败也保留args/PID/部分markers/日志/设备前后配置。observer不生成结果时为FAIL。

### Task 3: Copied firmware on real backend

**Files:** Extend `tests/test_gwemu_coreaudio.py`；复用已有音频 timeline 和 SourceGuard；修改 `tests/test_gwemu_audio_firmware.py` 的 run_capture，记录实际 startedHostNs 与即时 process.json，避免退出后重建时钟原点。

- [x] 按现有五场景 Mario/Zelda OFW、Flash Retro-Go、SD SPI1/OSPI 顺序复制所有源镜像，SD只改副本来固定NES核心。复用已验收 timeline 输入，不改按钮时刻迁就结果；CoreAudio默认选项代替WAV且观察器仅注入所拥有native。原始十hash/persistent session不动，SourceGuard成功/异常退出均复核；单场原生90/180秒不因checkpoint续期。
- [x] 三个稳定checkpoint间实际 callback PCM 必须非零且去DC有信号（normalized AC RMS>10/32768、audible样本>0.5sec），实际 guest configured_rate（OFW48003/Retro-Go48000）与设备rate分别断言。进入游戏独立检查截图；SAI produced/consumed只作互补遥测。保存实际callback gap/rate/queue/drop数据但无依据不把starvation当听音断续。每场用新证据目录、native正常退出，准确标注采样/设备/探针扰动与边界。
- [x] 若 observer 无法加载或输出设备不可用，保留失败、继续其它不依赖声卡的审查；不以WAV替换CoreAudio宣称通过。任何实证产品缺陷按systematic-debugging定位，产品修复另加真实RED/GREEN及相关回归/干净构建/审查。

### Task 4: Review and local closeout

**Files:** Create `docs/research/2026-11-12-gwemu-coreaudio.md`; update `docs/desktop/gwemu-migration.md` 和本计划。

- [x] 纯设施+合成+五游戏完整验证，设备配置前后比较、原十hash/artifact/submodules/旁manager/仅16603审计。observer设施及实际证据独立审查，所有错误如实记录；不宣称声学延迟、实体手柄、重负载所有客体节奏或全阶段退出。
- [x] 审查通过才父本地提交tests/docs；没有生产/native变化不发布。保持legacy默认和原有产品数据。

关闭记录：计划、实现、最终及日志补充审查通过；root合成1passed9.28s、五copied游戏5passed185.11s、纯设施11passed0.86s、完整Native/capture16passed1.97s（5既有opt-in WAV skip已另行验收）；独立26passed及日志失败注入通过。所有五trace最终双声道重解析通过，源十hash/artifact/source/sibling/仅16603与设备前后配置审计通过。tests/docs-only，默认legacy，父仓库只本地提交。
