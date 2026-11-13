# Windows 移植验证（2026-11-13）

目标主机 `sakura@172.16.40.35`，Windows 11 x64。项目 `D:\LLM_Work\Game_Watch\gnw-emu`，同级工具链目录 `toolchains`。验证使用复制到项目 `local` 的个人 Mario/Zelda 备份与隔离的临时 UserData，未操作实体设备。

## 工具链与已验证构建

- Node.js 24.20.0、Windows Python 3.13.15、MSYS2 UCRT64 GCC 16.2/CMake 4.4.5/Ninja 1.13.2。
- ARM GNU 10.3.1 (10.3-2021.10)、ARM GNU 15.2.1 (15.2.rel1)。
- manager 固件编译成功；SHA-256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`，与原有固件一致。
- Retro-Go SD bank2 固件与升级包编译成功（235764 / 1396740 字节）；补齐 xxd 后重新生成升级包，避免遗漏四字节长度字段。
- Flash-only 固件、FrogFS/LittleFS 和 64 MiB 外部 Flash 镜像完整生成；使用合成 `.gw` 资源仅验证工具链打包流程，不作为该资源的游戏运行验证。
- Windows mtools 4.0.50 生成 256 MiB SD 镜像；升级包从 FAT32 镜像读回与原文件 SHA-256 一致 `dd9dcc67bc1cb8432bcf8e2de457532f899a3d2e1c4016c9d9d1fdb05785a410`。
- LCD-Game-Emulator 核心固定 `e4bcf33fa0edb40dfe42fdbf140636084a11df35`，生成 v0.0.3 / 22928 字节核心包。
- Windows 桌面端 Electron/Vite 构建、TypeScript 检查通过。
- Windows 适用全套 Vitest 189 passed、0 failed、2 pending，包含实际 native manager；Python Flash 包装 9 passed（含 Windows LittleFS 独立读回验证），Windows transport helper 2 passed。
- Windows 原生 GDB 认证 4 passed，覆盖错误令牌不暂停 CPU、分段/重连、无令牌兼容和认证超时断开。
- Mario/Zelda 实际 Electron 测试 2 passed：画面、按键、保存/暂停恢复、manager sessions/info、来源哈希、native 正常退出；Mario 另完成 backup/verify-backup。
- 最终目录包的 Mario/Zelda 验收另有 2 passed，运行时移除 MSYS2/ARM 工具链 PATH；覆盖相同桌面流程及 Mario backup/verify-backup。
- 目录包 native 在仅含 Windows 系统目录的 PATH 下运行成功，原生 EXE 和全部 39 个 DLL 的 SHA-256 与包 manifest 一致。
- PowerShell 启动包装实际打开相对路径 Mario 配置并正常退出；全部脚本通过 Windows PowerShell 语法解析。
- macOS 20 项直接受影响单元回归、Flash 打包 9 项、资源/SD staging 9 项回归通过。

## 来源与修复

gwemu 新提交修复 Windows configure 的 CMake 路径和 libepoxy 的 EGL fallback，并添加可选的认证 GDB 前缀和两秒认证期限。manager 新提交添加 Windows 会话发现、ACL 验证、PID 校验及外部 GDB adapter。主仓库新增 PowerShell 工作流、DLL 递归依赖收集及 Windows 运行测试。

审查中复现并修复 bootstrap 的 gwemu 初始化遗漏、Bash 中误用 CMD copy、Flash 映射路径中的盘符冒号。实际 Windows 桌面另复现 Flash 映射拒绝 O_RDWR 重开，修正 FILE_SHARE_WRITE；认证计时器已触发但原生 socket 未断开，修正关闭过程中句柄保护标志的恢复 mask。两项分别由原生认证和桌面存档回归验证。

manager 实际构建另复现原生 GCC 依赖文件参数无法读取 MSYS `/d/...` 路径，改为相对构建目录；固件哈希确认修复没有改变产物。

## 最终交付

- 桌面程序：`D:\LLM_Work\Game_Watch\gnw-emu\desktop\release\win-unpacked\gnw-emu.exe`，保留整个 `win-unpacked` 目录即可运行。
- gwemu 提交：`9170bdd56ee536ecdde432e109543aea3a9401e9`；打包 native SHA-256：`f74e6d483db2a3a5f0d597129a433ccde95c4bb901702505d921b2c6faa85d0f`。
- manager 提交：`07593cea608085b541375b1590c20f075916eeb6`。
- 原始 ROM 和已有 UserData 保留；测试使用隔离数据，验证来源文件哈希未变化。目录包未配置代码签名证书。
- Windows 证据位于项目 `out/windows-full-tests.json`、`out/windows-e2e-final.log`、`out/windows-packaged-e2e.log`、`out/windows-acceptance` 和各固件构建日志。

## 后续修复：自带配置与文件拖放

仓库自带的 `profiles/mario.gnw.json` 和 `profiles/zelda.gnw.json` 使用 `../../firmware`，与原先验收专用的 `windows-*.gnw.json` 不同。已将四个原厂备份另行传至 `D:\LLM_Work\Game_Watch\firmware`，核验 SHA-256 与原始备份一致，两份自带配置通过 CLI 路径/镜像校验。固件未加入 Git。

新增主窗口 `.gnw.json` 拖放打开，复用可信 IPC、加载保护和最近记录。真实 Windows CDP 文件拖放测试在旧版本上失败（保持 idle），修复后的开发版通过（中文/空格文件名）。更新的目录包使用自带 `profiles/zelda.gnw.json` 通过拖放验收：Zelda 画面、运行中重新加载、无效配置/`.bin`/多文件拒绝、制作对话框期间禁止换 ROM、最近记录、页面不导航和来源文件哈希均验证。两次验收各 1 passed；本机配置/最近记录/菜单回归 13 passed，TypeScript 检查及独立代码审查通过。目录包 native 和全部 39 个 DLL 的哈希再次核验通过。

## 后续修复：启动倍率

启动、加载游戏和恢复普通窗口时，过大的默认/已保存倍率会降到当前显示器工作区能容纳的最大整数倍率；计算包含 DPI、机身边框和标题栏，调整后的倍率会保存。能正常容纳的已有倍率保持不变，恢复窗口时确保整个窗口位于工作区内。

Session 1 使用官方 Zelda 固件和隔离 UserData 验证四种情况：全新设置的默认 4× 降为 3×、重启保持 3×、旧设置 64× 降为 3×、已有 1.25× 保持不变。150% DPI、1707×1019 工作区下，3× 窗口为 1464×906，边框/按键菜单可用，4× 因超出工作区禁用。证据为 `out/windows-startup-scale-result.json` 及同名前缀的截图。Windows 窗口单元测试 16 项通过，本机完整单元测试 221 项通过，双方 TypeScript 检查和构建通过。

Windows 设置文件为 `%APPDATA%\gnw-emu-desktop\UserData\settings.json`；如需重置设置，完全退出后重命名此文件即可，保留 UserData 中的存档。

## 限制

旧 macOS 产品验收套件固定了原提交、路径和本机资产，不作为 Windows 通过依据。POSIX socket/inode/shebang 专有 fixture 在 Windows 排除；以 Windows 专有 ACL/认证/会话及实际桌面验证覆盖平台行为。未验证实体设备、实体手柄、扬声器听感或所有 Retro-Go 核心。
