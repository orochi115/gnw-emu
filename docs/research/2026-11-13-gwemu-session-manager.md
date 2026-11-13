# gwemu 当前桌面会话的 manager 验收

2026-11-13，Task6 软件集成验收通过。`desktop/tests/e2e/gwemu-manager.spec.ts` 的 **13 个场景全部通过，0 skip、0 flaky**；父测试 `tests/test_gwemu_session_manager.py` 通过。父测试是启动同一套真实 Playwright/Electron 场景的 pytest 入口，不另计一套模拟覆盖。桌面构建和 TypeScript 检查均退出 0。

## 实际接入方式

每个场景启动真实 Electron，显式设置 `GNW_KERNEL=gwemu`，使用独立临时 UserData。通过 UI 自动化取得 `app.getState.runtimeSessionId`，随后启动普通公开命令：

```sh
build/gnwmanager-python/bin/python -m gnwmanager --session UUID info
```

manager 使用生产发现目录 `/tmp/gnw-manager-${uid}`。测试没有注入发现目录、backend factory、TCP manager 替身或私有 supervisor；自动化 HTTP 仅驱动真实桌面 UI。源镜像只用于创建 profile，由生产 session store 复制到测试 UserData；备份、格式化、Flash、解锁和 SD 操作均写隔离会话。

## 验证内容

| 场景 | 证据与断言 |
| --- | --- |
| 当前 ROM 的存储流程 | `sessions` 列出精确运行 UUID；`info` 识别 Mario；完整双读备份、离线校验、真实本机 HTTP 获取后再校验、选区恢复 bank1/ext |
| Flash / LittleFS | 8192 字节确定性数据写入外部 Flash 后逐字节读回；LittleFS 格式化、建目录、写入、读回、删除，删除后列表不再包含文件 |
| SD SPI1 / OSPI | 分别加载真实 SD profile 的隔离副本；写入 `/TASK6.BIN`、逐字节读回、列表确认、删除后再次确认 |
| manager 截图 | 公开 `screenshot capture` 读取真实 SRAM framebuffer；PNG 签名、320×240 尺寸和 Electron 完整解码通过；保留 `manager-framebuffer.png` |
| GDB | 匹配 ELF 的实际 Thumb guest，真实 RSP：RAM 写入/读回、寄存器写入/读回、单步、`guest_loop` 断点命中；正常退出恢复运行 |
| monitor | 同一个实际 guest 的 ELF 对应 `logbuf/log_idx` 符号；公开 monitor 通过真实 RSP 输出精确日志；SIGINT 退出 130，所有权释放并报告 unknown/saveUncertain |
| 解锁 / 再保护 | 桌面默认 RDP0，先公开 lock 建立 RDP1，再走真实加密 payload、蓝屏和 SRAM 校验路径；备份与原始 Mario 内外 Flash SHA256 一致；恢复后再次 lock，`info` 确认 LOCKED |
| 执行初态 | running、paused、unpowered 各自执行公开 manager 命令，正常结束恢复原初态，管理标志和输入归零；断电状态使用不上传固件的 `device-state` |
| 供电 / POWER | USB 供电下拔电池仍有供电；再移除 USB 则完全断电；恢复电池、冷启动、POWER bit9、重新接 USB；pause、warm-reset、resume 的执行意图保持正确 |
| 管理中断 | 分别终止公开 CLI、杀死自有 native、真实关闭 UI 窗口，manager 退出非零，代理和拥有的端点清除；失败状态不宣称保存成功 |
| UI 排他 / 身份 | 管理期间 file.open、state.save/load 菜单禁用；真实 UI 输入和 F5/F8 不产生持键或存档；中断后重新加载获得新 UUID，旧 UUID 的公开 CLI 失败，新 UUID 正常可用 |
| 无 ROM | 实际空桌面状态 idle，无 native PID，进程树无自有 QEMU |

固定 RAM manager ELF 没有日志缓冲符号，因此 monitor/GDB 使用可复现的实际合成 guest 和对应 ELF。该 fixture 只在测试临时目录编译，不修改 manager C 固件或 native 协议。先前 Task5 已通过的 Zelda 工厂解锁、底层供电与竞争清理证据继续有效，本次没有重复整套底层验收。

## 中断关闭与 macOS 警告

管理中断必须进入保守失败状态。UI 关闭在 native 和 manager 端点清理后，会显示生产代码的 OS 原生“保存无法确认”警告。测试断言 `saveUncertain`，核对 native 已退出且全部自有端点已移除，再模拟用户明确 Force Quit；**不把 Force Quit 记成正常保存成功**。native 已先行退出的场景会在报告失败状态后正常关闭 Electron。

本机 macOS Accessibility 查询返回 false。测试没有修改系统权限或替换生产 dialog；没有自动点击该原生警告的“退出”按钮。这不影响上述会话撤销、native/端点清理和失败状态的实证。正常 manager 完成的所有场景仍验证真实正常关闭。

## 固定来源和保护

- native 公共源码：`a38484468d947ce6447fcc7dec47ebeef041f853`，manifest clean；二进制 SHA256 `a6ae9db084e1268fad8d5a4cc4bea3ba139dfe927a6b1d4d555197004515798e`。
- manager 公开 CLI：`9ef9cead5bd684cf47c39ccbd157a29ba01172b7`。RAM 固件来自既有 clean `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b` 构建，package firmware SHA256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`。
- `cli-source-v2.json`、`client-source-v4.json`、`failed-release-source.json` 冻结的生产文件在父测试前后逐一核对 SHA256。
- 十个原始镜像在 E2E 前后逐一 SHA256 核对；外来 discovery descriptor 不删除、不改写。各场景记录精确 UUID、命令参数/退出码、CLI/native PID、自有端点，结束后残留均为零。
- 实际 UserData、旁边的 manager 仓库、PID16603、`.superpowers` 和历史 native/固件构建均未作为写入目标。保护核对与来源冻结见下述材料。

证据目录：`out/gwemu-completion/manager-workflow/`。最终日志：`manager-workflow-final.log`、`manager-workflow-pytest.log`；机器结果：`manager-workflow-playwright.json`、`manager-workflow-source.json`。硬件和实体手柄仍按既有决定豁免，本文仅报告软件集成。

## 复现

在已有固定工具链、固件/SD 资产和可用 GUI 的机器上：

```sh
cd desktop
npm run build
npm run typecheck
cd ..
build/gnwmanager-python/bin/python -m pytest tests/test_gwemu_session_manager.py -q
```

也可从 desktop 直接运行 `npm run test:e2e -- tests/e2e/gwemu-manager.spec.ts`。必需资产或工具缺失即失败，不自动增加 skip。pytest 入口设置 900 秒总截止，各 CLI、UI 操作和应用清理另有有限截止。

本阶段只添加测试和记录，没有切换默认内核、退休 legacy 依赖或改动公开 manager/native 源码；后续产品迁移沿用原设计计划。
