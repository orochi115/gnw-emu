# Windows 移植验证（2026-11-13）

目标主机 `sakura@172.16.40.35`，Windows 11 x64。项目 `D:\LLM_Work\Game_Watch\gnw-emu`，同级工具链目录 `toolchains`。验证使用复制到项目 `local` 的个人 Mario/Zelda 备份与隔离的临时 UserData，未操作实体设备。

## 工具链与已验证构建

- Node.js 24.20.0、Windows Python 3.13.15、MSYS2 UCRT64 GCC 16.2/CMake 4.4.5/Ninja 1.13.2。
- ARM GNU 10.3.1 (10.3-2021.10)、ARM GNU 15.2.1 (15.2.rel1)。
- manager 固件编译成功；SHA-256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`，与原有固件一致。
- Retro-Go SD bank2 固件与升级包编译成功（235764 / 1396740 字节）；补齐 xxd 后重新生成升级包，避免遗漏四字节长度字段。
- LCD-Game-Emulator 核心固定 `e4bcf33fa0edb40dfe42fdbf140636084a11df35`，生成 v0.0.3 / 22928 字节核心包。
- Windows 桌面端 Electron/Vite 构建、TypeScript 检查通过。
- Windows 适用全套 Vitest 189 passed、0 failed、2 pending，包含实际 native manager；Python Flash 包装 9 passed（含 Windows LittleFS 独立读回验证），Windows transport helper 2 passed。
- Windows 原生 GDB 认证 4 passed，覆盖错误令牌不暂停 CPU、分段/重连、无令牌兼容和认证超时断开。
- Mario/Zelda 实际 Electron 测试 2 passed：画面、按键、保存/暂停恢复、manager sessions/info、来源哈希、native 正常退出；Mario 另完成 backup/verify-backup。
- macOS 20 项直接受影响单元回归、Flash 打包 9 项回归通过。

## 来源与修复

gwemu 新提交修复 Windows configure 的 CMake 路径和 libepoxy 的 EGL fallback，并添加可选的认证 GDB 前缀和两秒认证期限。manager 新提交添加 Windows 会话发现、ACL 验证、PID 校验及外部 GDB adapter。主仓库新增 PowerShell 工作流、DLL 递归依赖收集及 Windows 运行测试。

审查中复现并修复 bootstrap 的 gwemu 初始化遗漏、Bash 中误用 CMD copy、Flash 映射路径中的盘符冒号。实际 Windows 桌面另复现 Flash 映射拒绝 O_RDWR 重开，修正 FILE_SHARE_WRITE；认证计时器已触发但原生 socket 未断开，修正关闭过程中句柄保护标志的恢复 mask。两项分别由原生认证和桌面存档回归验证。

manager 实际构建另复现原生 GCC 依赖文件参数无法读取 MSYS `/d/...` 路径，改为相对构建目录；固件哈希确认修复没有改变产物。

## 限制

旧 macOS 产品验收套件固定了原提交、路径和本机资产，不作为 Windows 通过依据。POSIX socket/inode/shebang 专有 fixture 在 Windows 排除；以 Windows 专有 ACL/认证/会话及实际桌面验证覆盖平台行为。未验证实体设备、实体手柄、扬声器听感或所有 Retro-Go 核心。最终目录包验证结果在此补充。
