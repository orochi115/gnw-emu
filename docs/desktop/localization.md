# 界面语言与菜单

支持简体中文和英文，默认跟随系统（中文系统用简体中文，其他语言回退英文）。优先级为 `--language` > UserData/settings.json 的 language > 系统语言：

```sh
scripts/run.sh zelda --language=en
scripts/run.sh --language=zh-CN
```

language 接受 `system`、`zh-CN`、`en`；设置文件缺少字段默认为 system。启动时生效，当前没有语言设置页面，不在运行中切换语言。

main/renderer 各自初始化 i18next，共用 src/shared/locale.ts 中的词条。新增文案必须补齐两种语言，unit 测试核对词条集合。AppState.stage 是稳定的 prepare/connect/start/stop，业务 UserError 带 code/params；UI 边界再翻译。技术日志和自动化错误码保持诊断用途，系统文件选择器的操作系统按钮语言仍由操作系统/Electron决定。

原生菜单为文件、编辑、窗口；macOS 另有应用菜单。编辑仅包含撤销/重做、剪切/复制/粘贴、全选，使用 Electron 系统 role。窗口包含最小化/关闭窗口，macOS 额外包含缩放/全部置前；没有开发调试或全屏命令。macOS 退出在应用菜单，其他平台位于文件菜单末尾，稳定 ID 都是 app.quit。窗口关闭/退出复用保存路径。打开最近留待下一阶段。

制作界面的机型为分段单选组，方向键切换，自动化可点击 rom.model.zelda/mario。UID 不在制作界面中输入；需要特定器件身份的高级用户可编辑 JSON 的 deviceUid，仍受24位十六进制校验。省略时使用 QEMU 默认身份，不自动生成新的器件 UID。

SD 卡接线始终可见，未填入卡镜像时禁用。SPI1 为硬件 SPI，软件 SPI 复用外部 Flash 引脚；这不是 SPI Mode 0–3 设置。

文件 → 最近加载（File → Load Recent）：保存最近十个成功加载的配置路径，重复打开置顶，重启保留记录。支持清空，未加载成功或取消时不记录；启动时不自动加载。文件名后显示父目录以区分同名配置。历史和显示设置一起保存在 UserData/settings.json 的 recentRoms 中，ROM 配置和 QEMU 不负责保存这项应用偏好。
