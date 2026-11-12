# gwemu Gamepad Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 补齐已批准工具链迁移设计阶段一的手柄输入回归，验证 Chromium Gamepad API 到真实 gwemu 的路径、释放及供电/会话门禁。

**Architecture:** 沿用现有 GamepadInputReader→IPC→ControlRouter→InputController→KernelBackend/QMP，不新增产品功能或控制接口。真实 Electron 只覆盖 Gamepad API 软件快照，真实原生 qtest/QMP 另核对对应 GPIO。两层证据分开报告，不声称模拟器读到了物理 USB/Bluetooth 设备。继续使用 feat/gwemu-migration 隔离开发分支与新临时 UserData/session，原 PID16603、源镜像、用户 .superpowers 不动。

**Tech Stack:** Playwright/Electron、TypeScript、现有 automation diagnostics、Python/pytest Native、已固定 ae00b68 干净产物。

本计划是既有迁移设计中“现有键盘/手柄、热键、电源、换 ROM、关闭”的验收细化，不设计新行为。备选方式为仅跑 unit（不能证明 IPC/原生路径）或要求物理手柄人工全测（自动回归不可复现）；选择真实桌面内替换 navigator.getGamepads + 独立原生引脚读回，明确物理设备边界。realtime=false 缺口另行调查，不混入本批。

### Task 1: Native input boundary

**Files:** Create `tests/test_gwemu_gamepad.py`; reuse `tests/test_gwemu_desktop.py` Native。

- [ ] 对标准手柄现有8逻辑按钮所用qcode(left/up/right/down/x/z/ret/shift_r)发送真实QMP事件。配置相应GPIO为数字输入，再读D11/D0/D15/D14/D9/D5/C11/C12，确认按下低、释放高和其它相关引脚未变。QMP仅ACK不能替代引脚读回。
- [ ] 增加A+Left同时按住、仅释放A不影响Left的组合检查。只用合成临时镜像，native完整finally退出。
- [ ] Run `GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_gamepad.py`。输入路径已有实现，如通过属于验收；如失败按systematic-debugging定位，不猜测修改映射。

### Task 2: Real Electron Gamepad API acceptance

**Files:** Create `desktop/tests/e2e/gwemu-gamepad.spec.ts`。

- [ ] 复用现有固定binary opt-in测试、独立mkdtemp UserData、createProfile、automation RPC与焦点真实前置检查。新建证据目录，不覆盖早期截图。cleanup使用嵌套finally：app.close有界5秒；失败时记录cleanup错误，回收本测试app PID及其明确所属native/后代（不得按进程名全局kill），必要时TERM/2秒/KILL。失败证据和源hash审计必须在关闭失败时仍执行；临时目录最后删除。测试完整120秒，清理另有有界时间，结果保存到独立out。禁止操作产品进程，明确拒绝PID16603。
- [ ] 主窗口通过测试内navigator.getGamepads软件快照，正常requestAnimationFrame轮询和IPC，不直接调用controlInput/buttons、不直接设置appliedMask。getGamepads包装计数每次消费，focused快照更新后等待至少两个真实读取，再检查mask。对held/reconnect/pause/resume等负向零输入须连续250ms轮询diagnostics且保持零，期间焦点可运行路径额外确认reader读取推进；blur时不要求reader读取，但返焦后保持held再消费并持续零。记录真实Chromium物理设备列表，不接管物理输入。
- [ ] Mario/Zelda分别检查标准D-pad/A/B/Start/Select、模拟轴左右上下与死区滞回；检查desired/applied mask一致（真实QMP确认），且nativePID来自当前隔离会话。
- [ ] 检查手柄A+键盘A聚合，一侧释放不能释放另一侧；两个同指纹手柄同键分别释放，最后释放才归零；拔掉快照设备立即释放，带按键重连先中立才可触发。
- [ ] 在Zelda场景检查失焦、按键设置窗口隔离、暂停/继续、最后来源断电/接回/继续与换ROM。已持有输入释放并隔离，恢复后仍按住不得自动激活，松开再按才生效；换ROM sessionId/PID必须改变且旧native退出。以已有菜单/真实窗口切换操作，不关闭门禁。
- [ ] 可在临时settings中使用现有手柄双键热键配置核对mute与USB：同设备完整组合才触发，跨设备半组合不触发；暂停/无电仍允许既有供电热键。无新增绑定UI能力。
- [ ] Run `npm run build`、`npm run typecheck`；再 `npm run test:e2e -- tests/e2e/gwemu-gamepad.spec.ts`。若桌面锁屏导致焦点前置失败，保存失败并请用户解锁，不绕过焦点。

### Task 3: Review and closeout

**Files:** Create `docs/research/2026-11-12-gwemu-gamepad.md`; update `docs/desktop/gwemu-migration.md` and this plan。

- [ ] Run已有gamepad reader/router/participation以及kernel输入相关unit，新增native边界及真实Electron全部场景；只修改验收时无需重复无关固件全套。若实证需要产品行为修复，RED/GREEN与针对性GUI回归，必要时桌面全套，再审查。
- [ ] 独立审查测试设施、游戏/按钮证据和scope。核对十源hash与固定artifact、native/manager clean、旁manager revision、原PID16603及无任务native。
- [ ] 报告明确此处Gamepad API软件输入而非物理手柄接入验证；不把appliedMask等同于每个游戏对按键的反应，不声称实时设置/CoreAudio/阶段一全部通过。
- [ ] 审查通过后父仓库仅本地提交，排除.superpowers和ignored out；native未变不发布，默认legacy保持。
