# 桌面菜单、本地化与一键固件入口

用户已确认前一轮建议，并授权修改原有启动脚本；打开最近由本轮决定延后，不实现机身外观。

## 界面

i18next 共享简体中文/英文词条，主进程和 renderer 各自初始化同一语言。默认跟随系统，settings.json 的 language 或 --language=system|zh-CN|en 可覆盖（命令行优先）。普通 UI、原生菜单、对话框、校验/生命周期提示一起本地化；业务错误带稳定 code，自动化 ID 不随语言变化。技术日志保持诊断原文。

Edit 只保留 undo/redo、cut/copy/paste、selectAll，明确分组且使用系统 role。Window 只保留 minimize/close，macOS 额外 zoom/front。macOS Quit 在应用菜单，其他平台在文件末尾，统一 app.quit ID；不增加重复退出或全屏/开发调试菜单。

机型使用原生 radio 的分段样式，语义为 radiogroup，可键盘操作。移除制作表单 UID 字段，加载器仍接受手改 JSON 的 deviceUid。SD 接线始终可见，无有效路径时禁用；显示 SPI1（硬件 SPI，默认）和软件 SPI（复用外部 Flash 引脚）。

## 启动脚本

保留仓库 scripts/run.sh、run_sd.sh、run_sd_update.sh，增加 run_backup.sh，将父目录原有 wrappers 转为新版入口，另加 run_stock_emu.sh。父目录统一解析 GNW_EMU_DIR，默认选存在桌面工程的 gnw-emu-electron-ui，再选 gnw-emu；从任意 cwd 运行并安全透传 Electron 参数。

仓库公共 shell helper 检查 Node/desktop/QEMU，缺少桌面依赖或产物才构建。SD 启动通过 GNW_ASSET_DIR 显式选择资产根，当前 worktree 若没有资源则只读复用原 gnw-emu 的已准备资产。生成的配置、中间副本和运行存档仍写新版根目录。首次准备保留原有构建步骤；FRESH 只创建新身份/重建新版源卡，不删除既有存档或旧资产。

## 验证

语言解析/双语词条完整性、结构化错误翻译、三平台菜单模板单元测试；真实 Electron 双语、radio 键盘、UID 缺席、SD 使能、退出保存 E2E。Shell fixture 用实际 Node 配置生成器而以假的 Electron 捕获启动 argv，核对任意 cwd/带空格路径/参数/新身份/源镜像不变。真实原版/dump/SD直启/SD升级分别启动隔离会话验证，不以命令构造测试替代。依赖缺失需要如实记录。父目录脚本不属于仓库提交，文档单独列出。

实施复核：用户确认与本轮直接修改请求作为编码授权。独立只读审阅任务收到不可读消息，未得到有效审阅意见，不记录为审阅通过。采用本地逐项复核与上述自动化/实际启动证据；平台与人工检查的范围见验证文档。
