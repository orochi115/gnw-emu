# gwemu 隔离桌面开发预览实测

日期：2026-11-12。本批次在已批准迁移设计的阶段一内接通开发桌面；默认仍为旧内核，完整阶段一及阶段二/三尚未完成。此前证据保留在 [首批基线](2026-11-12-gwemu-baseline.md)，启动方式见 [迁移说明](../desktop/gwemu-migration.md)。

## 固定来源

公开独立仓库 [orochi115/gwemu](https://github.com/orochi115/gwemu) 的 `gnw-emu` 分支固定为 `f74441159ccbe2fd265affbb03cd26f655addfe3`。本地 push 后使用 `git ls-remote origin refs/heads/gnw-emu` 核对一致；上游历史与许可证保留。

从干净提交首次构建到独立 `build/gwemu-desktop`，未复用增量实验目录。`gnw-build-manifest.json` 的 revision 与上述一致，`sourceDirty=false`，tracked diff 为空，产物 SHA-256 为 `46b3a496828a9c8e64edf4462712244273316eb833e073a825f2a80383497bdf`。宿主为 Apple arm64/macOS 24.6.0、Apple clang 17、Python 3.15.2；本次没有非 macOS 运行证据。

构建日志在 `out/gwemu-desktop-clean-build.log`。上游含构建时间信息，manifest 用于来源追溯，不承诺跨宿主或重复构建字节相同。

## 接入行为与隔离

`GNW_KERNEL=gwemu` 仅允许未打包桌面，必须显式传入独立 `--user-data-dir=`；默认二进制固定为上述目录。镜像、lease 和原生 sidecar 位于该目录的 `kernels/gwemu` 命名空间。项目与系统产品 UserData 的祖先/子目录、符号链接别名在任何目录创建前拒绝。Electron 会在 main 执行前将 `userData` 重定向到命令行目录，因此 main 在存在 override 时从 `appData` 与应用名计算默认产品位置，用于保护路径校验；最小 Electron 路径探针复现了这一行为。

原生桥监听 composed display surface，GNWF v1 输出 640×480 RGBA；保持 ACK 背压、部分 IO 和最新待发帧。只移植通用传输/锁代码，未复制旧 STM32 模型。原生子进程在镜像初始化前取得 session lock，并持有至退出。帧地址仅接受 `127.0.0.1` 与 1..65535 十进制端口，拒绝 QEMU `addr=` 参数覆盖。

UID 支持 24 hex 对应的 12 raw bytes，未提供时沿用上游合成 UID；非法值在镜像初始化前拒绝。静音通过 `/machine/soc/sai1` 的 `audio-muted` 属性设置，在音频 voice 重建后仍生效，guest DMA 保持运行。

桌面通过同一 QMP 连接发送标准 `input-send-event` 差量按键，先释放再按下；启动恢复运行后发送全释放。加载新配置前校验容量、OSPI、UID 和二进制能力，不兼容配置保留当前运行。GDB 默认关闭，宿主 `GNW_*`/`GWEMU_*` 自动化变量不会传入内核。

正常 exit0 后同步 session 镜像和 sidecar，再保存元数据；未实现的电源配置原值保留。崩溃或强制终止标记保存不确定。即时存档菜单禁用，热键及电源操作提示未支持，旧 slots 不读不写。

## 验证结果

| 检查 | 最终固定产物上的证据 |
| --- | --- |
| 原生 pytest | 15 项通过：GNWF 像素/alpha/部分 ACK/背压、无效握手、UID/非法 UID、锁冲突与退出释放、PCM 静音、5 个地址拒绝用例及原容量回归 |
| 桌面 Vitest | 38 个文件、139 项通过，包括真实 gwemu 控制器、启动取消、参数、保护目录、旧生命周期和即时存档回归 |
| 桌面编译 | typecheck 和 build 成功 |
| gwemu Electron | 1 项通过：持续帧、640×480、实际 Canvas 超过 20000 个亮像素、按键、模态焦点释放、静音切换、禁用存档菜单、换 Mario、关闭后无 QEMU、源哈希不变 |
| 旧默认内核 Electron | automation-ui 与 main-window 共 2 项通过 |
| 四组同镜像探针 | 两内核均 captured/exit0，四组 sourceUnchanged=true |
| 审查 | 原生规格、TS 复审与最终代码审查通过；地址覆盖问题修复后有真实无连接回归 |

原生音频验证实际 WAV 的非零 PCM → 全零 → voice 重建后全零 → 恢复非零，不能仅凭 QOM 值代替。帧测试将合成蓝色面板的像素与 screendump 对照；无效握手后 QMP 仍可用。

真实控制器测试通过 QTest 读取 GPIO，确认 Left 对应 GPIOD IDR 的低有效 bit11 随按下/释放变化；在 session 内部 Flash `0x08000100` 写入 `0x12345678`，正常关闭重开后仍存在，源缓冲区不变。不兼容 2 MiB NOR 和 OSPI 保留运行中的 session；SIGKILL 后标记保存不确定，再启动成功且锁可复用。

启动取消回归先复现了准备参数期间 stop 提前完成、随后可能产生孤立子进程的问题。修复在参数准备完成后才转移 runtime 所有权，加入取消检查及等待，stop 等待启动清理；原回归和旧生命周期通过。

Electron 首次沙箱运行无法启动 GUI，授权后重跑。人工查看曾发现截图过早捕获了 QEMU 的启动提示，随后提高像素条件并重跑，最终截图 `out/gwemu-desktop-preview/zelda-desktop.png` 已人工确认显示 Zelda 固件开场图。该 profile 使用显式 UID `310047000b51333138343134`；这证明 UID 参数路径和实际画面可用，完整 OFW 身份/冷启动行为仍需专门回归。

最终测试日志：`out/gwemu-preview-final-tests.log`、`out/gwemu-preview-e2e.log`、`out/gwemu-preview-legacy-e2e.log`、`out/gwemu-preview-desktop-final-build.log`。最终审查记录在 `out/gwemu-preview-final-review.txt`，这些本地证据不提交源码仓库。

## 固件与 SD 观察

沿用首批同镜像 profile，全部重新复制镜像；SD 也独立复制。墙钟观察 3 秒，Retro-Go 两组在 0.5 秒按住 left+game 0.3 秒。四组均核对源前后哈希，无变化。探针关闭音频；按键墙钟时点不能作为同步游戏回归。

| Profile | 本地报告目录 | gwemu 最终截图观察 |
| --- | --- | --- |
| Mario OFW | `out/gwemu-preview-mario` | PRESS TIME BUTTON |
| Zelda OFW | `out/gwemu-preview-zelda` | PRESS TIME BUTTON |
| Flash-only Retro-Go | `out/gwemu-preview-flash-retrogo` | 坦克游戏的游戏选项菜单 |
| SPI1 SD Retro-Go | `out/gwemu-preview-sd-retrogo` | Atari 7800 / Ace of Aces ROM 选择页 |

人工查看的拼图在 `out/gwemu-desktop-preview/probe-montage.png`。每组 `report.json` 记录当前固定产物哈希、源/session 哈希、寄存器、RTC、UID、GDB 能力和启动参数。OFW profile 未指定 UID，保留上游合成值；SPI1 SD 可见菜单不代表游戏、写回或断电恢复验收完成。

## 后续门槛

阶段一还需电池/USB 与冷启动、软件 SPI、完整 Flash 即时存档/回滚、音质/延迟/实时限速、RTC 休眠恢复，以及 gnwmanager RAM 固件和备份/恢复/刷写实测。OSPI、未支持 NOR 容量继续拒绝。普通桌面 CLI 仍使用旧内核；当前开发预览不能用于宣称完整工具链已迁移。

阶段二备份工具迁移、阶段三当前 session 发现与单客户端交接尚未实施。主仓库保持本地功能分支，不切换默认内核，不归档旧 fork，不读取或覆盖产品 session、历史存档及源 ROM。
