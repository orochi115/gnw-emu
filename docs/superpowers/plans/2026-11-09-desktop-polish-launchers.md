# 桌面完善与启动脚本实施计划

> 执行 executing-plans，内联完成。用户已授权当前修改，无需再次请求编码许可。

**Goal:** 补齐双语与原生菜单组织，简化 ROM 表单，提供原版/dump/SD 一键启动。
**Architecture:** 共享词条与结构化错误；独立菜单模板；shell 共用准备助手 + Node CLI。
**Tech Stack:** i18next、Electron、React、Vitest、Playwright、POSIX shell。

1. 先写 locale/menu 单元测试和双语表单 E2E，确认新增行为失败；添加共享 i18n 与菜单模块，接入主进程/renderer/系统对话框。
2. 改机型为 radio、移除 UID、始终呈现 SD 接线，更新实际 E2E 校验焦点场景。
3. 写 shell fixture 验证参数/路径/资产复用/源副本/身份，先失败再实现助手、backup 和父目录 wrappers。
4. typecheck、build、全桌面测试与真实固件四条启动路径；只对改动相关原生场景补测，不重复无关十分钟 soak。
5. 更新使用/本地化/自动化/验证文档，重建 macOS 目录包并 smoke，提交新版仓库，单独记录父目录变更。

执行结果：第 1–4 项已完成，相关单元/GUI/原生检查通过。四条真实启动脚本验证已完成，菜单 Quit 通过原生 role 命令触发。文档与 macOS 目录包已更新，最后整理提交；未推送/合并。详见 docs/desktop/validation.md。
