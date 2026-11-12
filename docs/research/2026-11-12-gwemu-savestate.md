# gwemu 完整存档与 Flash 回滚验收

日期：2026-11-12。状态：原生、桌面存储层、生命周期及 Electron 验收通过；规范、质量及最终实现复审通过。暂停/断电宿主热键误阻挡已修正并完成真实 GUI 验证。本批原生提交已公开发布，父仓库对应提交仅保留在本地 feat/gwemu-migration 分支。本报告不代表迁移阶段一整体完成。默认仍为 legacy，旧 session、槽位及源 ROM 保留。

## 构建与来源

上游为 slash-proc/gwemu，基线 3bfce5fd26a402660a8526b3a7ffc92048c3966a。独立集成仓库为 [orochi115/gwemu](https://github.com/orochi115/gwemu)。本批原生本地提交依次为 28dac42（格式及 Flash）、6541c2f（运行状态）、830192d（JPEG/LTDC）；公开 gnw-emu 分支已发布到 `830192d221a70f2dff5fc466ac5d3c3c74bca584`，已用 git ls-remote 核对远端 SHA。

验收产物为 `build/gwemu-savestate/qemu-system-arm`，revision `830192d221a70f2dff5fc466ac5d3c3c74bca584`，manifest 的 sourceDirty=false，实际 SHA-256 为 `97070d62d7d8a02b6d58b3357a9de3bef21b34d27a2e0e09c4973952451da286`。构建来源和宿主依赖记录在产物旁的 `gnw-build-manifest.json`，不承诺跨宿主构建字节相同。

## 状态契约

原生 `instant-states` 默认关闭。桌面开发入口开启它并传入 profile UUID，保存与读取要求暂停、绝对路径、严格支持应答。独立头部和 payload checksum 在修改状态前检查 ROM 身份、容量、UID、RTC 与电源配置。文件映射 Flash 的 RAMBlock 纳入完整 VMState；读取后写回当前 session 文件的原 inode 并同步，RDP sidecar 的同步失败会向上报告。

电量、USB、电池存在、充放电相位、启动交接和自动 POWER 脉冲随状态恢复。恢复重建供电输入和执行门禁，不做冷启动。host RTC 回到保存时的日历和秒内相位，重定位宿主时钟 anchor 后继续推进；fixed RTC 随虚拟时间回退。校时暂存、shadow lock 和闹钟剩余时间保留。

OTFDEC 从恢复的原始 Flash 重建解密映射并刷新翻译缓存。JPEG 保存有界动态缓冲区及游标，等待实际 worker 完成并丢弃旧 epoch 结果。LTDC 保存 active/shadow 寄存器、两组 CLUT、扫描阶段和已呈现画面，暂停读档也能显示恢复画面。SAI 清除宿主未来音频队列、重建输出，保留 guest DMA 相位及当前宿主静音设置。

不支持任何 SD 接线、超过 64 MiB 的外部 Flash 或实验 timing 模式。状态不兼容 legacy，也不承诺跨构建兼容。桌面 `states-gwemu/` manifest v2 绑定实际二进制 SHA；legacy `states/` v1 保持原样。旧构建槽位可以显示时间，读取会明确拒绝，显式保存成功后才替换槽位引用。

## 已完成的独立验证

| 范围 | 结果 | 验证内容 |
| --- | --- | --- |
| 干净产物原生回归 | 159 项通过，22.23 秒 | 格式/失败路径、Flash、CPU/RAM、供电/RTC、GPIO/OSPI/HASH、OTFDEC、JPEG、LTDC、SAI |
| 既有固件回归 | 16 项通过，148.01 秒 | copied-ROM 冷循环、供电、RTC，含 legacy 对照及 SD |
| 新真实固件存档 | 4 项通过，14.77 秒 | Mario 1 MiB、Zelda 4 MiB、Flash-only Retro-Go 64 MiB；各两次同进程读取及退出重开 |
| 桌面存储与能力层 | 186 项通过，14.37 秒 | 实际产物身份、无源镜像能力探针、命名空间、槽位原子替换及恢复点 |
| 桌面全套含生命周期 | 217 项通过，40.36 秒 | 暂停/断电读取、输入隔离、恢复故障、停止及排队 ROM 切换；规范/质量/最终复审通过，typecheck/build 通过 |
| 解锁后的 Electron 回归 | 7 项通过，41.8 秒 | 新 gwemu 存档、供电、预览、SD、自动化、主窗口和 legacy 存档 |

真实固件测试使用 TCG 和临时镜像副本，检查 CPU、BKPSRAM 标记、RTC、供电、完整 raw Flash SHA、inode 及暂停画面。即时重新保存证明原生虚拟时间精确回退；继续执行超过 20 ms 并获得新 GNWF 序列/宿主时间戳，分别证明 guest 执行和显示回调继续，Retro-Go 保持 bank2 VTOR。十个原始镜像的大小/哈希未变；GUI 完成后再次复核一致。只有原有 legacy QEMU PID16603 保留，无测试模拟器残留。

Flash 验收包含实际 OSPI WREN/擦除/编程和内部 CR 扇区擦除。内部编程证明的是 PG shadow 与可写 bank 映射；默认外部 NOR 不强制电气 WEL、1→0 或真实时序。该证据不能替代实机精度、gnwmanager 管理固件刷写或保护转换验收。静态 UI 可以保持相同画面，是否取得新显示回调单独核对。

## 桌面验收与复现

桌面规范审查要求的四组补充证明已通过独立复审：空槽及构建不兼容的延迟拒绝、未完成按键发送与快照准入交叠、快照期间成功/无效 ROM 切换，以及 QMP 实际断连后的恢复与关闭。补充 targeted 检查共 45 项通过，复审独立运行 25 项真实内核控制器测试通过。Electron 首次 F5 未触发，诊断发现 macOS `IOConsoleLocked=Yes`、窗口无法取得焦点。解锁后七组真实 Electron 回归全部通过，未覆盖焦点判断或用 controller 注入代替热键。

最终审查另用实际 ControlRouter 复现独立问题：main 将非运行状态加入全局输入门禁，连 USB 供电与 F5/F8 宿主操作也被拒绝。修复已区分 guest 硬件输入和可用宿主操作，同时保留状态操作、启动/关闭、模态窗口和失焦的全局隔离。补充真实内核测试证明暂停/断电 F5/F8、USB 热键可用且不发送 guest 按键；规范/质量及最终实现复审通过，真实 GUI 的暂停/断电 F5/F8 与 USB 热键也已通过。

```sh
GWEMU_BUILD_DIR=build/gwemu-savestate sh scripts/build_gwemu.sh
GWEMU_BINARY="$PWD/build/gwemu-savestate/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_savestate.py tests/test_gwemu_savestate_runtime.py tests/test_gwemu_savestate_peripherals.py
GNW_FIRMWARE_STATE_TEST=1 GWEMU_BINARY="$PWD/build/gwemu-savestate/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_savestate_firmware.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-savestate/qemu-system-arm" GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-savestate/qemu-system-arm" npm test
npm run typecheck
npm run build
npm run test:e2e -- tests/e2e/gwemu-savestates.spec.ts
```

固件检查依赖本地镜像，缺少时明确跳过；上述通过记录均无跳过。忽略目录 `out/gwemu-savestate/` 保存构建、审查、测试日志和固件画面证据。管理 RAM 固件、备份迁移和当前会话发现仍属于后续工作；旧内核退休条件尚未满足。
