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

## 后续修复：Win32 菜单、桌面时钟与 portable

Windows 主菜单及桌面时钟右键菜单改用 Win32 HMENU；复用 Electron 菜单的状态、角色和快捷键模型。时钟拖动采用客户区指针捕获，避免标题栏右键和双击行为；进入时钟时禁止最大化/全屏，退出恢复原能力。工具栏置于画面之后，只在其区域悬停/聚焦时显示。新增四边停靠和拖动结束后的边缘吸附。

Session 1 使用真实 Windows 鼠标及原生菜单 API 验证 `#32768` 菜单、子菜单、勾选/禁用状态、边框切换、打开按键设置、双击不最大化、工具栏隐藏/显示及返回、四角停靠与拖动吸附左边缘。另通过中文菜单和空窗口时的禁用状态检查。原生菜单会吞掉键盘释放消息；实际复现取消菜单后方向键保持按下，补上菜单前的输入释放/同步与关闭后的重新启用，最终验证按键归零和下一次按键正常响应。

Portable ZIP 含 EXE 相邻的 `portable.txt`，数据写入同级 UserData。使用真正解压的 ZIP 在有空格的目录运行，搬移并重启后时钟/停靠偏好保留；显式数据路径覆盖优先，已有 AppData 设置哈希未变化。完整验收为 5 组通过，本机 227 项单元测试通过，Windows 单元测试（跳过平台不适用项）、双方类型检查/构建及 PowerShell 语法检查通过。复现入口为 `desktop` 下的 `npm run test:windows-clock`，结果见 `out/windows-clock-portable-result.json`、`out/windows-clock-portable-final.log`、`out/windows-native-menu-chinese.json`。

普通包已更新至原正式路径，120 个打包文件逐项哈希与验收包一致。Portable 交付为 `desktop/release/portable/gnw-emu-0.1.0-win-x64-portable.zip`，203857667 字节，SHA-256 `69d5c5a3a9253edc24bea755f58c842d405d2bff9fbbca7122163bfa41208123`。旧普通包变更文件备份在 `out/clock-portable-package-backup`；用户设置和固件保留。

## 限制

旧 macOS 产品验收套件固定了原提交、路径和本机资产，不作为 Windows 通过依据。POSIX socket/inode/shebang 专有 fixture 在 Windows 排除；以 Windows 专有 ACL/认证/会话及实际桌面验证覆盖平台行为。未验证实体设备、实体手柄、扬声器听感或所有 Retro-Go 核心。

## Windows 横向菜单和拖动尺寸回归（2026-11-14）

普通模式在现有标题栏横向显示菜单，按本地化文字、窗口按钮实际宽度及 48 DIP 拖动区域判断是否折叠。Session 1 验证半倍率折叠、3× 恢复横向菜单，并通过真实鼠标枚举两种入口的 Win32 `#32768` 下拉菜单；中文文件/设备/编辑/设置/视图/窗口文字及加载 ROM、普通模式即时存档菜单也通过验证。标题栏标签由应用绘制，下拉菜单保持 Win32 HMENU；macOS 系统菜单保留。

旧版在 150% DPI 连续三次拖动后由 488 DIP 增宽至 576 DIP；单独调用 Electron setBounds 和 setPosition 也会增长。改用 SetWindowPos 的 SWP_NOSIZE，只移动位置，拖动和停靠均不回传尺寸。修复后六次往返真实鼠标拖动和左侧吸附，窗口及客户区物理宽高均严格保持 320×240；DIP 包围矩形随物理原点舍入最多变化 1 DIP，没有累积。时钟右键菜单移除设备及即时存档，返回、停靠、边框、静音、倍率和退出继续正常使用。

完整普通包/portable 验收 8 组通过，包括菜单取消后按键重新响应、双击不最大化、工具栏显示/返回、ZIP 解压搬移重启、显式 UserData 覆盖，以及普通版 AppData 设置哈希不变。本地 45 个测试文件、231 项单元测试通过；Windows 新增构建保护及窗口回归 20 项通过。类型检查、双方构建和独立代码审查通过。运行结果在 out/windows-clock-portable-result.json、out/windows-menu-drag-final.log、out/windows-menu-bar-chinese.json；截图在 out/windows-menu-layout-0.5.png、out/windows-menu-layout-3.png、out/windows-menu-bar-chinese.png。

打包期间发现 electron-builder 会清空已使用 portable 输出目录中的 UserData；本次旧目录被清理，用户确认只是试运行、没有需要保留的数据。已添加 beforePack 保护：输出目录有 UserData 则在清理之前拒绝打包。真实 Windows builder 验收以 exit 1 拒绝该情况，设置文件哈希和旧包哨兵文件保留，结果在 out/package-data-guard-result.json。今后使用绿色版应移至独立运行目录，或选择新的构建输出目录。

普通正式包已更新，120 个打包文件逐项哈希与验收包一致，旧变更文件备份在 out/menu-drag-package-backup。最新 portable ZIP 为 desktop/release/portable/gnw-emu-0.1.0-win-x64-portable.zip，203858244 字节，SHA-256 `4b5360d66732aadd659317239050798ed058c6a86a6eefc4e2b2ee3213680028`。普通版用户数据、固件和自用 Windows profiles 保留。
