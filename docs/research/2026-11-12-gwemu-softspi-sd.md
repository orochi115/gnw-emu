# gwemu 软件 SPI SD 接线实测

日期：2026-11-12。阶段一的独立交付批次；未切换默认内核，未合并主分支，未归档旧 fork。

## 结果

隔离 gwemu 预览支持现有 `.gnw.json` 的 `sdWiring: "ospi"`，并保留缺省/显式 `spi1`。两种接线均通过真实 SD Retro-Go 的 bank2 启动、文件系统挂载、NES core 运行、固件存档及进程退出后的独立 FAT 文件读回。原生和桌面另验证扇区写入、停止后重开及源卡不变。全部源 bank1/bank2/Flash/SD 的 SHA-256 前后相同。

## 原生与桌面改动

- 小型 GPIO mode-0 桥连接 PB2 CLK、PB1 MOSI、PD12 MISO、PE11 高电平选择 SD，复用上游 `ssi-sd` / `sd-card` 后端。GPIO 模式门控屏蔽 Flash AF 流量；PD12 仅在数字输入模式覆盖读回。
- 启动属性 `sd-wiring=spi1|ospi`；缺省 SPI1 保留上游既有行为。软件模式下 SPI1 TXDR/DMA 不同时消费同一张卡。
- 完整 MOSI 字节提交后，将 SSI 回复排入下一字节，增加一字节延迟；保留普通字节边界 CS 间隔的待发响应，第八位保持到固件采样。部分字节取消不等于任意中途协议恢复或卡断电。
- 真实固件暴露上游 CMD12 缺陷：中断 CMD18 的下一块预读后，残留计数/CRC 会让后续 CMD17 的最后两字节被 CRC 替代。新增两条 RED 测试分别在 SPI1/软件 SPI 复现，四行修复清除被中断块的计数/CRC，GREEN 覆盖完整块和卡寄存器 CRC。
- 桌面参数同时适配无帧探针和预览；预检缺少 `sd-wiring` 的旧产物时，在停止活动 ROM 前拒绝。镜像只绑定隔离 session；完整即时存档仍禁用。

## 固定源码与产物

原生独立提交便于后续贡献上游，已发布至 [orochi115/gwemu](https://github.com/orochi115/gwemu/tree/gnw-emu)，远端 SHA 已核对：

| 项目 | 值 |
| --- | --- |
| CMD12 修复 | `da35d7a` |
| GPIO 接线提交 | `040b7e2c94ef322c446d7b01a43554764f8eb022` |
| 产物 | `build/gwemu-softspi/qemu-system-arm` |
| manifest | `build/gwemu-softspi/gnw-build-manifest.json`，`sourceDirty=false` |
| SHA-256 | `96d5dc7de144a1e6804063201e21f452f4019cd68c2a7ba3ecdf0fcbf9e0139a` |

同既有构建脚本，以 QEMU arm-softmmu、Darwin arm64、Python 3.15.2 和本机 Xcode 工具链从干净源码构建。旧构建目录保留对照。

## 验证与夹具边界

| 检查 | 结果 |
| --- | --- |
| 原生初始化/帧/UID/锁/音频/电源/SD | 38 项通过，其中 12 项 SD 新测试 |
| 桌面 Vitest | 39 文件、145 项通过 |
| TypeScript / desktop build | 通过 |
| Mario/Zelda/Flash-only/SD 电源固件回归 | 4 项通过 |
| SD 真实固件 | SPI1/type2、软件 SPI/type3 共 2 项通过 |
| Electron gwemu | 现有预览、软件 SPI SD 共 2 项通过 |
| Electron 默认旧内核 | automation-ui 1 项通过 |

真实固件复制本地 `out/profiles/sd-full_20261104_1021-spi1.gnw.json` 的四个镜像。为让游戏验收与源卡的多 core 翻页/欢迎弹窗设置独立，在测试卡副本中只保留 fceumm core 并删除 CONFIG，固定 RTC 为 2025-01-01。ROM 与源镜像保留原样；Electron SD 验收使用未裁剪的原始卡内容的 session 副本；确认双键 appliedMask=129 后保持一秒，并检查 Retro-Go 顶部绿色栏，排除官方启动画面误通过。实际截图复核为 SD Retro-Go launcher。此前完整卡已验证软件 SPI 可注册 16 个 core 系统，测试聚焦不掩盖挂载/多扇区读取问题。

QTest 仅观察实际 TCG 固件；检查 `VTOR=0x08100000`、`fs_mounted=1`、`sdcard_hw_type=2/3`、NES core 路径和初始化日志。通过普通按键启动游戏与 Save & Continue；软件 SPI 的同步文件读取较慢，测试按固件 `uwTick` 持续按键以确保实际采样。两种接线生成 `/data/nes/010 Kage.nes-0.sav`（13846 bytes），退出后用 mtype 独立读回。单个 PC 可能采样到固件服务函数，不能仅用 PC 是否处于 bank2 判断 core 身份。

最终日志位于 `out/gwemu-softspi-{native,desktop,firmware,power-firmware}-final.log`、`out/gwemu-softspi-e2e.log`、`out/gwemu-softspi-legacy-e2e.log`。截图与变量/源哈希/存档哈希证据在 `out/gwemu-softspi-sd/`。早期 RED/调试日志保留诊断历史，最终结论以上述 final 日志为准。最终审查通过（`out/gwemu-softspi-final-review.txt`）；规格/质量审查记录位于 `out/gwemu-softspi-{native,desktop}-{spec,quality}-review.txt`。

## 剩余迁移范围

本批不证明真实 SD 卡供电、电池断开、电源域失电、完整 Flash 即时存档回滚或跨内核旧存档兼容。固件存档的独立读回不替代全产品即时存档，也尚未验收固件恢复所有 slot。RTC 全流程、真实冷启动/ITCM/RDP、管理 RAM 固件与 gnwmanager 会话接入、音质和实时限速，以及设计阶段二/三仍待后续批次。
