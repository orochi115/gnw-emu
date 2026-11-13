# gwemu 唯一内核产品验收

日期：2026-11-13。对应产品退休计划 Task 3–5。旧 UserData 导入按用户决定取消；实体设备与实体手柄验证豁免。

## 最终产品行为

开发默认 `build/gwemu/qemu-system-arm`，目录包默认 resources 内的 gwemu。没有 ROM 时不启动 native；加载 `.gnw.json` 后从 baseline 复制独立 session，正常持久化到 `UserData/kernels/gwemu/sessions/<profileId>`。旧 session 和 slots 不扫描、不导入、不改写。legacy 选择明确报错；产品没有第二套内核执行分支和实时模式切换。正常保存/加载继续校验 gwemu 内核、profile 和实际二进制身份，加载失败保留完整回滚语义。

构建固定公开源码 `a38484468d947ce6447fcc7dec47ebeef041f853`，manager 固定公开源码 `9ef9cead5bd684cf47c39ccbd157a29ba01172b7`。当前 canonical native SHA256 为 `f21a3ac5a16ef6ceb259ca864d170ebe22f2d9261acee24beba39b14537c4545`。macOS 重定位后 SHA256 为 `6ef2af7a41d73dcc212b6cceed91511b0ac2b7a003c45a9952c438cdace00136`，包内包含原构建 manifest 和实际 staging manifest，不把两者误认为同一产物。

## 软件证据

原始日志和哈希冻结位于 `out/gwemu-completion/`，以下为实际执行结果，不把 deselected、skip 或历史失败记为通过。

| 验收范围 | 结果与证据 |
| --- | --- |
| 产品单元/集成基础 | 首轮 306 项中 305 通过，唯一过期取消夹具修正后直接回归 8 项通过。复用其余有效结果；`sole-kernel-full-v1.log`、`sole-kernel-direct-final.log` |
| canonical 默认路径 | 5 项通过，`canonical-default-direct.log` |
| canonical native | 172 项通过、零 skip；覆盖设备、电源、RTC、时钟、输入、音频、软件 SPI、RDP、即时存档/完整 Flash 回滚、运行时/外设；`canonical-native-regression.log` |
| 真实固件 RTC | 4 项通过，`canonical-rtc-firmware.log` |
| 构建/启动/stage | 13 项通过，`product-launch-packaging-tests.log`；canonical 维护直接检查 7 项通过，`canonical-maintenance-direct.log` |
| canonical 产品集成 | 最初 69 项通过；manager-server 的 24 项失败全部发生在旧产物固定哈希断言，修正为 canonical manifest 后整文件 29 项通过，`canonical-manager-server-direct.log` |
| 桌面原功能 | 保留最初 5 个有效结果，串行直接回归再通过 automation UI 和真实 OFW 热键/保存/重开 2 项；最后 Mario 软件手柄、OSPI SD、完整供电用例 3 项通过、零 skip，`gui-debug-fixed.log`。原日志 `product-final-desktop-e2e.log`、`product-desktop-direct.log` 保留失败记录 |
| 当前会话 manager | canonical/default 下真实 Electron 13 项和公开 CLI 40 次调用；零 skip/flaky/unexpected；pytest 桥接 1 项通过。`product-final-manager.log`、`product-final-manager-pytest.log`、`product-final-manager-playwright.json` |
| 实际目录包 | 2 项真实 Electron 通过：键盘/缩放、无 ROM 零 native、公开 manager、USB 单独供电/拔电池、持久化/重开、实际 staged 身份即时存档保存/加载；`product-package-e2e-final.log` |
| 目录包清理 | 重建应用并审计 asar：只有 cli/ui-cli，无旧比较工具和 legacy executor；7 个运行文件与构建输出一致，native、原 manifest、全部 20 个依赖库哈希一致；`product-package-audit.json` |
| 四个工作区启动入口 | stock、完整备份、SD 直启、SD 升级全部实际 Electron 运行/显示/退出保存通过，4 项、零 skip；`product-launchers-final.log` |
| 类型和数据保护 | `product-final-typecheck.log` exit 0；`product-final-source.json` 核对公开源码 clean/exact SHA、10 个源镜像、78 个实际 UserData 文件元信息、用户 `.superpowers`、旁 manager 和 PID 16603 均未变，owned native 零遗留 |

首次两个 GUI runner 并发导致系统焦点争用和共享 Playwright 产物冲突，失败日志完整保留，之后仅串行复查原失败项。Mario 诊断明确捕获失焦后 reader 停止、输入被正常拦截；夹具现在建立实际窗口/文档焦点。SD 和供电的历史失败没有完整根因快照，不能断言相同原因；它们的全部原断言在建立输入/菜单焦点前提后串行通过。未修改生产输入门禁或 native/manager。

Task 3/4 的有界只读规范/质量检查见 `product-entry-review.txt`，没有具备具体严重后果的 Critical/Important 产品缺陷。两项已计划清理均处理：包内旧生成比较工具已排除，夹具改用 canonical 构建/manifest。没有重开全量 APPROVED 审查循环。

## 限制与后续历史收尾

历史入口验证再次执行 canonical 构建时，上游 `scripts/gwemu-version.sh` 的日期标头触发重链接，源码/配置未变但哈希变化。最终产物以完成报告为准：native `f6d37ae14c0075f970cea501234a711072ea2cd64cbfb6defa7327573d0b5552`，macOS staged `6a0003f8f5d246a7cbdfed45451152f79dc28ac93e66f907607096fffd2212c4`。新产物实际 185 项 native 回归通过（`final-native-regression.log`），重新 staging/构建/哈希审计及 2 项真实目录包用例通过（`final-package-e2e.log`）。上文哈希保留为 Task 3–5 当时的实证，不冒充最终产物。

上述记录完成产品 Task 3–5，不能单独代表旧依赖退休已完成；最终 tag、维护索引清理和旧 fork 归档见 [历史说明](2026-11-13-gwemu-migration-history.md)及最终逐项迁移报告。实机/实体手柄由用户之后验证。Windows/Linux 目录包未在此次 macOS 环境构建验收；实际 SSH 主机传输仍沿用受控 runner 验证，不宣称真实远端连接通过。没有父仓库远程推送。
