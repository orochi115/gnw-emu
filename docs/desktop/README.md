# gnw-emu 桌面应用

Electron 游戏主窗口支持加载 `.gnw.json` 和将已有 Flash/SD 镜像组合为 ROM 配置。第一阶段没有机身外观、设置、改键、手柄或调试页面。

- [开发、运行与打包](development.md)
- [进程边界与生命周期](architecture.md)
- [JSON 格式及存档](json-format.md)
- [UI 自动化与 CLI](automation.md)
- [日志](logging.md)
- [像素传输协议](frame-protocol.md)
- [验证记录与限制](validation.md)

主窗口：文件 → 加载 ROM…（Cmd/Ctrl+O）、制作 ROM…（Cmd/Ctrl+N）。制作只生成配置，不编译固件或制作 SD 文件系统。源镜像不会被修改。

方向键为十字键，X/Z 为 A/B，G/T/P/O 为 GAME/TIME/PAUSE/POWER，Return/Tab 为 START/SELECT。-/= 调整电量，C 切换 USB 电源。打开对话框、失焦、切换或关闭时释放设备输入。
