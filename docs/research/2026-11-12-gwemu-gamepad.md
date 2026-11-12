# gwemu 手柄输入链路验收

本批补齐迁移阶段一的标准手柄软件输入与原生输入边界回归。沿用现有 Chromium GamepadInputReader→IPC→ControlRouter→InputController→KernelBackend/QMP，不修改产品、原生或 manager。默认仍为 legacy。

## 来源与隔离

沿用干净原生源码 `ae00b68951ab44b0dffb265e3f61340d735a68e5` 和 `build/gwemu-manager-ram/qemu-system-arm`，SHA-256 为 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`。每次 Electron 启动前检查实际产物哈希与干净 manifest。manager 固定 `7a82d653f23b5e3b5802eb4ce1e5076f94aa379b`，本批不变。

使用本机 Darwin arm64、已安装 Electron 39/Playwright/Vitest 和独立 Python 环境。每例新建临时 UserData 与 Mario/Zelda profile，原四个 ROM 只作为 session 复制来源，前后全量 SHA 必须相同。新建 `out/gwemu-gamepad/electron/<model>-<unique>/` 留存 JSON/截图，不覆盖历史捕获。测试不操作产品 session、旧 states 或原 legacy PID16603。

## 原生输入边界

`tests/test_gwemu_gamepad.py` 在合成临时镜像上经真实 QMP 发送事件，配置数字输入后用 qtest 读 GPIO。八个标准手柄逻辑按钮对应：

| 逻辑按键 | qcode | 实际引脚 |
|---|---|---|
| Left | left | PD11 |
| Up | up | PD0 |
| Right | right | PD15 |
| Down | down | PD14 |
| A | x | PD9 |
| B | z | PD5 |
| Start | ret | PC11 |
| Select | shift_r | PC12 |

逐个验证按下低、释放高，其它七个引脚未变；另验证 A+Left 同按和只释放 A 时 Left 保持按下。9 项通过（0.33 秒）。这证明 QMP 到原生引脚的独立边界，不用 QMP ACK 代替引脚读回。

## 真实 Electron 回归

`desktop/tests/e2e/gwemu-gamepad.spec.ts` 只在测试 renderer 替换 `navigator.getGamepads` 的返回快照，仍由真实 requestAnimationFrame 轮询、preload IPC 和主进程路由送入当前 gwemu。没有直接调用 controlInput/button 或设置 mask。启动后记录 Chromium 暴露的物理设备名称，但输入验证使用软件快照。

- Mario/Zelda 各验证八键、轴的四方向、0.26/0.22/0.19 死区滞回、键盘与手柄 A 聚合、两个同指纹手柄分别释放、断连释放，以及带按键重连必须先中立。
- Zelda 的边界例验证同设备双键静音、跨设备半组合不触发；真实窗口失焦、按键设置窗口隔离、暂停/继续、最后供电来源丢失和 USB 双键恢复、换 ROM 后已持有输入归零。恢复后保持按住不能自动激活，松开再按才有效。换 ROM 必须更换 sessionId/PID，旧 native 必须退出。
- 每次 focused 快照更新后等待至少两次真实 getGamepads 读取；负向零输入随后连续约 250 ms 读取真实 diagnostics，并在可轮询路径检查读取计数继续推进。不会用一个即时零样本宣称门禁通过。

Playwright 当前 Chromium 初始化会发送 `Emulation.setFocusEmulationEnabled(enabled=true)`，所以失焦测试不能依靠 DOM `document.hasFocus()` 的假设。夹具等待测试 probe 窗口页面加载并实际取得焦点，再检查主 BrowserWindow.isFocused=false 和产品发布的 windowState.focused=false；返回时检查原生窗口和主 renderer 焦点恢复。不发送 synthetic blur 或关闭产品门禁。早期 `blur()`/DOM 焦点前置失败保留在 first/boundaries 日志；原镜像审计与进程清理仍完成。

## 清理设施与失败证据

每例总期限 120 秒；应用正常关闭最多等待 5 秒。专用 `tests/e2e/helpers/owned-processes.ts` 仅记录本测试 Electron PID 的后代及已观察的本测试 native PID，拒绝 PID16603。进程枚举失败仍尝试关闭和已知所属进程回收，必要时 TERM→2 秒→KILL；另等待回收并报告关闭/枚举错误，不能把强制清理当正常关闭通过。

主夹具的嵌套 finally 使源哈希与独立结果 JSON 在关闭失败时仍执行，最后删除临时 UserData。失败时另尝试 1.5 秒内截取 failure.png，Playwright 保留 trace。代码审查发现原夹具先查询进程树，`ps` 失败会跳过 close；故障注入复现 closed=false 的 RED，再用修正后的设施得到 GREEN。两个独立负例分别注入枚举失败和关闭失败，确认错误被报告、关闭仍尝试、所属 native 被回收。

## 复验命令

```sh
GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" \
  .venv/bin/python -m pytest -q tests/test_gwemu_gamepad.py
cd desktop
GWEMU_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" \
GWEMU_DESKTOP_BINARY="$PWD/../build/gwemu-manager-ram/qemu-system-arm" \
  npm test -- tests/unit/gamepad-input.test.ts tests/unit/control-router.test.ts \
  tests/unit/device-participation.test.ts tests/unit/kernel-backend.test.ts \
  tests/unit/owned-processes.test.ts
npm run typecheck
npm run build
npm run test:e2e -- tests/e2e/gwemu-gamepad.spec.ts
npm run test:e2e -- tests/e2e/controls.spec.ts -g 'Gamepad API inputs'
```

证据位于 `out/gwemu-gamepad/`：native.log、unit-final.log、typecheck-final.log、build.log、e2e-final.log、legacy-pad.log，以及每个独立捕获的 acceptance.json。最后两组 GUI 需在已解锁桌面顺序执行。

## 最终结果与审计

原生 9 项通过；输入及失败设施单元测试 33 项通过（225 ms）；typecheck/build 通过。三场景 gwemu Electron 回归 3 passed（32.2 秒），既有 legacy 手柄输入回归 1 passed（3.8 秒），均无跳过。

| 最终场景 | 独立证据目录 | 所属 native PID |
|---|---|---|
| Mario 映射/轴/聚合/重连 | `electron/mario-xywffr` | 40532 |
| Zelda 映射/轴/聚合/重连 | `electron/zelda-ilk9Id` | 40566 |
| Zelda 门禁与换 ROM 到 Mario | `electron/zelda-CaPVTL` | 40601 → 40614 |

三份 JSON 均记录前后源哈希一致、无 cleanupErrors、所有所属 native 已退出；最后一例两组 sessionId/PID 不同，旧进程在换 ROM 后即退出。Chromium 三例物理设备列表均为空。截图只是桌面/固件启动画面证据，不宣称这批操作已进入游戏或验证游戏对每键的响应。

完整十源大小/SHA-256 与先前 RAM 批次基线相同，固定源码/实际 artifact/manifest 一致，native 与 manager 子模块及旁边原 manager 干净。最终进程审计仅原 legacy PID16603，无本批实验 native。证据为 `source-final.json`、`process-final.json` 和 `capture-final.json`。

## 范围与剩余工作

本批覆盖 Gamepad API 软件路径和独立 QMP/GPIO 边界，不能声称物理 USB/Bluetooth 驱动、连接兼容性、无线延迟、震动或所有游戏对每键的反应已验证。appliedMask 表示输入已由当前内核接口确认，实际引脚证据来自另一个合成原生实例，二者不冒充同一设备的同步采样。

未改生产实现，因此无新的真机读写影响或 native/manager 发布。CoreAudio 端到端音频、realtime=false 偏好仍未适配，其余阶段一退出项、备份迁移和当前会话/保护流程继续按原设计推进。最终审查与安全审计通过后只在父仓库本地提交本批验收。

最终独立审查 **APPROVED**（`out/gwemu-gamepad/final-review.txt`），审查者另运行相同五文件 33 项单元检查通过（228 ms），独立复算十源哈希/产物并核对最终截图与进程。只批准本批软件输入与原生边界，不代表全部迁移完成。
