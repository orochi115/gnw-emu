# gwemu 阶段一首批基线实测

日期：2026-11-12。范围：固定来源、独立构建与同镜像启动观察；尚未完成桌面内核替换。

## 固定来源与产物

上游 `slash-proc/gwemu` 的 `gnw-h7b0` 基线是 `3bfce5fd26a402660a8526b3a7ffc92048c3966a`（gwemu v0.0.29 / QEMU 11.0.2）。集成源码是公开独立仓库 [orochi115/gwemu](https://github.com/orochi115/gwemu)，固定修复提交 `28936af4e4147f2b92514ee4b640022d00f75aa2`。GitHub 将其上游与现有 `orochi115/qemu` 归入同一 fork 网络，无法创建第二个用户 fork，因此经用户确认采用独立仓库，保留上游来源与历史。发布时由临时 GitHub Actions 完整克隆上游，并核对 tree 与原始 commit 对象 SHA；对象上传后由现有用户权限建立 `gnw-emu` 引用。临时导入分支已删除，最终默认分支为 `gnw-emu`。

本机 Apple arm64、macOS 24.6.0、Apple clang 17.0.0、Python 3.15.2、Ninja 1.13.2。干净源码构建到 `build/gwemu-fork`；`gnw-build-manifest.json` 保存配置、工具/依赖和实际源码状态。增量构建会重新生成含时间的版本信息，因此产物哈希可能变化，不能声称字节可复现。以下四组实验均使用最后一次增量构建后的同一产物。

| 内核 | 版本 | 二进制 SHA-256 |
| --- | --- | --- |
| legacy | QEMU emulator version 11.1.3 (v11.1.3-2-gbf6c2d6) | `49f522a529840e8bd7d4db83878690f590879ac934089a70de850a55cdb712fd` |
| gwemu | QEMU emulator version 11.0.2 (v0.0.29-1-g28936af) | `fd28a2f9af9be52a863cbcbd317834346e029d611e0ef2c9f3aacfd4c23c7117` |

## 初始化缺陷与修复

未修改上游在 Mario 1 MiB NOR 上，QMP greeting 后 capabilities 超时。`sample` 堆栈定位到 `gnw_h7b0_soc.c` 的 unlock baseline memcpy：固定复制 Zelda 长度 `0x30c3a8 + 1300`，超过实际 mmap 容量。原始诊断在 `out/gwemu-baseline-mario/headless-stack.txt` 与该目录报告中。

修复将实际 NOR 长度传入初始化；baseline 先填 `0xff`，只复制 `min(capacity, baseline_size)`，保留原 sidecar 格式与长度。代码进入固定提交，`patches/gwemu/0001-limit-unlock-baseline-to-flash-capacity.patch` 仅供审查，构建不修改源码。原生回归已观察修复前 1 MiB 失败/4 MiB 通过，修复后两者通过；测试同时核对 QMP、sidecar 长度/内容和源文件不变。

## 同镜像观察

入口与重现命令见 [迁移实验说明](../desktop/gwemu-migration.md)。每个内核独立复制全部镜像，包括 SD；未挂载源文件，未读取既有产品 UserData。开始时核对副本与源哈希，结束后重新核对源哈希。四组报告的 `sourceUnchanged` 均为 true，两个内核均为 `captured`，均正常退出。

| 配置 | 本地证据目录 | 旧内核观察 | gwemu 观察 |
| --- | --- | --- | --- |
| Mario OFW | `out/gwemu-final-mario` | 09:00 时钟 | 首次 PRESS TIME BUTTON |
| Zelda OFW | `out/gwemu-final-zelda` | 09:00 时钟 | 首次 PRESS TIME BUTTON |
| Flash-only Retro-Go | `out/gwemu-final-flash-retrogo` | OFW 时钟，VTOR 0x08000000 | Retro-Go 游戏菜单，VTOR 0x08100000 |
| SPI1 SD Retro-Go | `out/gwemu-final-sd-retrogo` | OFW 时钟，VTOR 0x08000000 | SD Retro-Go ROM 选择页，VTOR 0x08100000 |

观察时长是运行后墙钟 3 秒。Retro-Go 两组在 0.5 秒按住 left+game，0.3 秒后松开。两内核启动速度不同，按键时不处于同一虚拟阶段；这两组不能作为同步游戏场景通过或旧内核启动失败的证据。原图位于每个 session 的 `screen.png`，人工查看的拼图是 `out/gwemu-final-montage.png`。gwemu 截图为 640×480，旧内核为 320×240；未作像素一致性验收。

固定 RTC 2026-01-01 09:00，四组两内核暂停时的 RTC TR/DR 原始读回均为 `0000090001812600`。gwemu 必须同时设置 `gnw-h7b0-rtc.initial-epoch`，单独 `-rtc` 不足以设置其自定义 RTC。UID 读回：旧内核 `310047000b51333138343134`，gwemu `455157474d00554d01000000`；后者是上游合成 UID，不能宣称 OFW 身份行为等价。

四组均实际连接 gwemu GDB Unix socket，校验 RSP checksum 后收到：

```text
PacketSize=20020;qXfer:features:read+;vContSupported+;multiprocess+
```

这只证明 GDB 入口与能力协商存在；尚未验证 gnwmanager 的寄存器布局、分包、管理固件或完整命令流程。

### 镜像身份

以下哈希来自最终报告，路径采用仓库工作区相对表示。完整本地绝对路径、前后 session 哈希和启动参数保存在对应 `report.json`，实验产物不提交源码仓库。

| 配置 | 区域 | 源文件 | 字节数 | SHA-256 |
| --- | --- | --- | --- | --- |
| mario | internalFlash | `firmware/internal_flash_backup_mario.bin` | 131072 | `b1f10bde11490dcf922524fcba1592ffbc47d2b9a95cda58358ab8934c747e5b` |
| mario | externalFlash | `firmware/flash_backup_mario.bin` | 1048576 | `24b4fb870b27f63e8a72a4cc985914d665cea0df8a937a8d93af61ad31b7da77` |
| zelda | internalFlash | `firmware/internal_flash_backup_zelda.bin` | 131072 | `ab37ba03bc33682c091b4e7caffd7d3102b83e675377e06d6d3046b9bf483bb6` |
| zelda | externalFlash | `firmware/flash_backup_zelda.bin` | 4194304 | `ab89fa56257e5158e5405bb3c5b85f1a6960e8358db66d6bb62e567b26672a0f` |
| flash-retrogo | internalFlash | `game-and-watch-backup/backups/full_20261104_1021/bank1.bin` | 262144 | `c858b01f64b03069f94e78027d3d6a148d5201d3333efd2eeabf178b5dcaa77c` |
| flash-retrogo | externalFlash | `game-and-watch-backup/backups/full_20261104_1021/ext.bin` | 67108864 | `8ec4b9bccceb9d776fc984b865797cb4a05292bb02297aeed022b30ad99a7846` |
| flash-retrogo | bank2Flash | `game-and-watch-backup/backups/full_20261104_1021/bank2.bin` | 262144 | `34f6eefaf52953287865ce71b11b483d36cabb6f9bbe8858d69db466f3e94803` |
| sd-retrogo | internalFlash | `gnw-emu/out/sd/full_20261104_1021_bank1.bin` | 262144 | `729a45a22b3b1840aa2f6ba37d89d05ba653e5154a770218596cd5f14845158f` |
| sd-retrogo | externalFlash | `game-and-watch-backup/backups/full_20261104_1021/ext.bin` | 67108864 | `8ec4b9bccceb9d776fc984b865797cb4a05292bb02297aeed022b30ad99a7846` |
| sd-retrogo | bank2Flash | `gnw-emu/externals/retro-go-sd/build/gw_retro_go_intflash.bin` | 235660 | `43c547fe2ca6d24f339a1f2ee8cfb857a46f0e30ceac948258a8cbd0e27178c1` |
| sd-retrogo | sdCard | `gnw-emu/out/sd/sdcard.img` | 1073741824 | `c92c2e5155768bcfd714ab598d72400e695a1ae31c5b9c57764f48861bf4bdbc` |

## 下一批接入缺口与回归门槛

| 接口/行为 | 本批次证据与限制 | 后续修改位置与验收 |
| --- | --- | --- |
| 产品启动参数 | 实验映射使用 bank1/bank2/extflash QOM 属性和 SD drive，未进入产品启动流程 | `desktop/src/core/qemu-command.ts`、`session-controller.ts`：明确内核身份与能力；换 ROM/退出/失败清理回归 |
| 帧显示 | QMP screendump 可用；上游没有旧 `frame-endpoint` 帧流契约 | gwemu LCD/显示桥与桌面帧接收端：尺寸、持续帧流、背压、断连和显示 E2E |
| 音频/静音 | 探针统一禁音，没有验证音频 | gwemu SAI/音频后端、`session-controller.ts`：音频输出、静音、退出无残留进程 |
| 输入与热键 | gwemu 使用标准 `input-send-event`，旧内核使用 buttons 位掩码；只验证组合键启动观察 | 输入桥：键盘/手柄、按住/释放、焦点丢失、组合键与热键 E2E |
| RTC、UID、OFW 启动 | RTC 初值已读回；UID 不同；OFW 首次启动画面不同 | gwemu SoC/RTC 属性与产品参数：显式 UID、首次启动/冷启动、固定/宿主时间、休眠后 RTC |
| 电源/状态/锁 | 缺少旧 battery、usb-power、state-file、session-lock 等产品契约；未模拟断电 | gwemu 机器/电源适配与 `session-lease.ts`：电池存在/断开、USB、冷启动、关闭结果、互斥进程 |
| Flash/SD | SPI1 SD ROM 菜单可见；OSPI/显式 UID 拒绝；1–256 MiB 支持芯片表不含 2 MiB；较短内部 bank 在副本中填 ff | gwemu Flash/SD：软件 SPI 接线、刷写/持久化、跨进程重开、断电与错误恢复；源不变 |
| 即时存档 | 没有调用 save/load，不假定迁移格式或完整 Flash 回滚成立 | `savestate-store.ts`、`session-controller.ts` 和 gwemu 状态接口：CPU/RAM/外设/完整 Flash 回滚；保留 SD/容量限制；跨内核旧存档拒绝且保留文件 |
| gnwmanager | 仅 GDB qSupported；未运行 RAM 管理固件 | 后续单独计划：RAM 固件、RDP/选项字节、备份/恢复/刷写等实测；阶段三单客户端交接与会话入口 |

只有现有桌面与管理固件相应回归通过后，才能切换唯一内核。当前不移除旧 QEMU、backup 或历史存档。阶段二与阶段三尚未实施。

## 验证记录

- 最终固定 fork 产物：34 个 Vitest 文件、130 个测试通过，包括原生逗号路径/RTC/环境隔离测试；typecheck 与桌面 build 成功。
- `GWEMU_BINARY=... .venv/bin/python -m pytest -q tests/test_gwemu.py`：2 个原生容量回归通过。
- 独立完整构建成功，最终增量构建成功，manifest sourceDirty=false。
- 四组最终探针退出码为 0；源哈希均不变。启动观察与截图不代替音频、持久化、电源或即时存档验收。
- 最终代码审查未发现 Critical/Important 问题；修正文档对预检查哈希失败的报告范围描述。
