# gnw-emu 桌面应用

Electron 游戏主窗口支持加载 `.gnw.json`、将已有 Flash/SD 镜像组合为 ROM 配置，以及可关闭的 Mario/Zelda 机身与交互按键。支持共享的键盘/手柄映射、连发和热键配置。

- [一键启动原版、dump 和 SD 固件](launchers.md)
- [自定义按键、手柄与热键](controls.md)
- [界面语言与菜单](localization.md)
- [机身外观、按键、边框与桌面时钟](chassis.md)
- [开发、运行与打包](development.md)
- [进程边界与生命周期](architecture.md)
- [JSON 格式及存档](json-format.md)
- [即时存档、flash 回退与槽位](savestates.md)
- [UI 自动化与 CLI](automation.md)
- [日志](logging.md)
- [像素传输协议](frame-protocol.md)
- [验证记录与限制](validation.md)

主窗口：文件 → 加载 ROM…（Cmd/Ctrl+O）、制作 ROM…（Cmd/Ctrl+N）。制作只生成配置，不编译固件或制作 SD 文件系统。源镜像不会被修改。

默认方向键为十字键，X/Z 为 A/B，G/T/P/O 为 GAME/TIME/PAUSE/POWER，Return/Q 为 START/SELECT。两种模式均支持 Tab=SELECT、Enter=START，即使机身按钮有焦点也不改变含义；制作对话框保留标准键盘行为。-/= 调整电量，C 切换 USB 电源。打开对话框、失焦、切换或关闭时释放设备输入。通过“编辑 → 自定义按键…”修改；点击录制先更新草稿，页底保存后写入 settings.json。
