import { createInstance } from "i18next";
import { ZodError } from "zod";
import { UserError } from "./user-error";
export type Locale = "zh-CN" | "en";
export type LanguagePreference = Locale | "system";
const en = {
  "menu.file": "File",
  "menu.open": "Load ROM…",
  "menu.make": "Make ROM…",
  "menu.quit": "Quit",
  "menu.edit": "Edit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",
  "menu.window": "Window",
  "menu.minimize": "Minimize",
  "menu.zoom": "Zoom",
  "menu.front": "Bring All to Front",
  "menu.close": "Close Window",
  "menu.about": "About gnw-emu",
  "menu.hide": "Hide gnw-emu",
  "menu.hideOthers": "Hide Others",
  "menu.showAll": "Show All",
  "app.empty": "No ROM loaded",
  "app.failed": "Unable to run",
  "app.emptyHint": "Load a ROM from the File menu to start playing.",
  "app.loadHint": "Load ROM",
  "app.dismiss": "Dismiss",
  "app.game": "Game screen",
  "rom.title": "Make ROM",
  "rom.description":
    "Combine existing images into a ROM configuration you can load.",
  "rom.model": "Model",
  "rom.internalFlash": "Internal Flash",
  "rom.externalFlash": "External Flash",
  "rom.bank2Flash": "Bank 2",
  "rom.sdCard": "SD card image",
  "rom.deviceUid": "Device UID",
  "rom.sdWiring": "SD card wiring",
  "rom.formatVersion": "Configuration version",
  "rom.id": "Configuration identity",
  "rom.profile": "ROM configuration",
  "rom.optional": "Optional",
  "rom.optionalImages": "Optional images",
  "rom.chooseImage": "Choose an image file",
  "rom.browse": "Browse…",
  "rom.browseField": "Browse {{field}}",
  "rom.spi1": "SPI1 (hardware SPI, default)",
  "rom.ospi": "Software SPI (external Flash pins)",
  "rom.wiringHint": "Choose an SD card image to enable wiring selection.",
  "rom.cancel": "Cancel",
  "rom.save": "Save…",
  "rom.saveAndLoad": "Save and Load…",
  "rom.saving": "Saving…",
  "dialog.open": "Load ROM",
  "dialog.image": "Choose an image",
  "dialog.save": "Save ROM Configuration",
  "error.invalidField": "{{field}}: Invalid value. Please check and try again.",
  "error.imageRead": "{{field}}: Cannot read file {{path}}",
  "error.imageSize":
    "{{field}}: The image is empty or exceeds the supported size.",
  "error.profileExtension": "Choose a .gnw.json ROM configuration file.",
  "error.profileChanged":
    "The existing ROM configuration differs from the supplied images. Use --fresh to create a new identity; previous saves will be kept.",
  "error.leaseRecovery":
    "Save data is in use: another launcher is checking ownership.",
  "error.leaseUnknown":
    "Save ownership is unknown. Confirm that all emulator processes have exited.",
  "error.leaseOccupied": "Save data is in use by another emulator.",
  "error.busy": "Another operation is in progress. Please wait.",
  "error.dialogBusy": "A file dialog is already open.",
  "error.makerOpen": "Close the Make ROM dialog first.",
  "error.startup": "The emulator failed to start ({{code}}). {{detail}}",
  "error.exited": "The emulator exited unexpectedly ({{code}}).",
  "error.controlDisconnected": "The emulator control connection was lost.",
  "error.displayExited": "The display process exited ({{code}}).",
  "error.timeout": "Timed out while {{action}}.",
  "error.saveUncertain":
    "The emulator did not exit normally. Saving could not be confirmed.",
  "error.saveTitle": "Saving could not be confirmed",
  "error.fileAccess": "Cannot access file {{path}} ({{code}}).",
  "error.unexpected": "The operation failed. {{detail}}",
  "stage.prepare": "Preparing images",
  "stage.connect": "Connecting to emulator",
  "stage.start": "Starting game",
  "stage.stop": "Saving and closing",
  "action.connect": "connecting to the emulator",
  "action.frame": "receiving the game screen",
  "action.release": "releasing buttons",
  "action.quit": "closing the emulator",
  "action.kill": "terminating the emulator",
  "action.prepareDisplay": "preparing the display connection",
  "action.closeDisplay": "closing the display connection",
};
const zh: Record<keyof typeof en, string> = {
  "menu.file": "文件",
  "menu.open": "加载 ROM…",
  "menu.make": "制作 ROM…",
  "menu.quit": "退出",
  "menu.edit": "编辑",
  "menu.undo": "撤销",
  "menu.redo": "重做",
  "menu.cut": "剪切",
  "menu.copy": "复制",
  "menu.paste": "粘贴",
  "menu.selectAll": "全选",
  "menu.window": "窗口",
  "menu.minimize": "最小化",
  "menu.zoom": "缩放窗口",
  "menu.front": "全部置于前台",
  "menu.close": "关闭窗口",
  "menu.about": "关于 gnw-emu",
  "menu.hide": "隐藏 gnw-emu",
  "menu.hideOthers": "隐藏其他应用",
  "menu.showAll": "全部显示",
  "app.empty": "尚未加载 ROM",
  "app.failed": "暂时无法运行",
  "app.emptyHint": "从「文件」菜单加载 ROM，开始游戏。",
  "app.loadHint": "加载 ROM",
  "app.dismiss": "关闭提示",
  "app.game": "游戏画面",
  "rom.title": "制作 ROM",
  "rom.description": "组合已有镜像，保存为可直接加载的 ROM 配置。",
  "rom.model": "机型",
  "rom.internalFlash": "内部 Flash",
  "rom.externalFlash": "外部 Flash",
  "rom.bank2Flash": "Bank 2",
  "rom.sdCard": "SD 卡镜像",
  "rom.deviceUid": "器件 UID",
  "rom.sdWiring": "SD 卡接线",
  "rom.formatVersion": "配置版本",
  "rom.id": "配置身份",
  "rom.profile": "ROM 配置",
  "rom.optional": "可选",
  "rom.optionalImages": "可选镜像",
  "rom.chooseImage": "请选择镜像文件",
  "rom.browse": "浏览…",
  "rom.browseField": "浏览{{field}}",
  "rom.spi1": "SPI1（硬件 SPI，默认）",
  "rom.ospi": "软件 SPI（复用外部 Flash 引脚）",
  "rom.wiringHint": "选择 SD 卡镜像后即可设置接线方式。",
  "rom.cancel": "取消",
  "rom.save": "保存…",
  "rom.saveAndLoad": "保存并加载…",
  "rom.saving": "正在保存…",
  "dialog.open": "加载 ROM",
  "dialog.image": "选择镜像",
  "dialog.save": "保存 ROM 配置",
  "error.invalidField": "{{field}}：内容不合法，请检查后重试",
  "error.imageRead": "{{field}}：无法读取文件 {{path}}",
  "error.imageSize": "{{field}}：镜像为空或超出支持范围",
  "error.profileExtension": "请选择 .gnw.json ROM 配置文件",
  "error.profileChanged":
    "现有 ROM 配置与输入不同；使用 --fresh 创建新身份，原存档会保留",
  "error.leaseRecovery": "存档被占用：另一个启动器正在核验租约",
  "error.leaseUnknown": "存档被占用：租约归属未知，请确认所有模拟器进程退出",
  "error.leaseOccupied": "存档被另一个模拟器占用",
  "error.busy": "正在处理另一个操作，请稍候",
  "error.dialogBusy": "文件对话框已打开",
  "error.makerOpen": "请先关闭制作 ROM 对话框",
  "error.startup": "模拟器启动失败（{{code}}）：{{detail}}",
  "error.exited": "模拟器意外退出（{{code}}）",
  "error.controlDisconnected": "模拟器控制连接已断开",
  "error.displayExited": "画面接收进程退出（{{code}}）",
  "error.timeout": "{{action}}超时",
  "error.saveUncertain": "模拟器未正常退出，无法确认状态保存",
  "error.saveTitle": "无法确认本次状态保存",
  "error.fileAccess": "无法访问文件 {{path}}（{{code}}）",
  "error.unexpected": "操作失败。{{detail}}",
  "stage.prepare": "正在准备镜像",
  "stage.connect": "正在连接模拟器",
  "stage.start": "正在启动游戏",
  "stage.stop": "正在保存并退出",
  "action.connect": "连接模拟器",
  "action.frame": "接收游戏画面",
  "action.release": "释放按键",
  "action.quit": "退出模拟器",
  "action.kill": "终止模拟器",
  "action.prepareDisplay": "准备画面端点",
  "action.closeDisplay": "关闭画面接收端",
};
export const resources = {
  en: { translation: en },
  "zh-CN": { translation: zh },
};
const instance = createInstance();
export function initializeLocale(locale: Locale) {
  void instance.init({
    lng: locale,
    fallbackLng: "en",
    resources,
    keySeparator: false,
    initAsync: false,
    interpolation: { escapeValue: false },
  });
}
initializeLocale("en");
export function chooseLocale(
  system: string,
  preference: LanguagePreference = "system",
  override?: string,
): Locale {
  const choice = override ?? preference;
  if (!["system", "zh-CN", "en"].includes(choice))
    throw new Error("language must be system, zh-CN or en");
  return choice === "system"
    ? system.toLowerCase().startsWith("zh")
      ? "zh-CN"
      : "en"
    : (choice as Locale);
}
export function t(key: string, params?: Record<string, unknown>): string {
  return String(instance.t(key, params ?? {}));
}
export function fieldLabel(field: string) {
  return t(`rom.${field}`, { defaultValue: t("rom.profile") });
}
export function errorMessage(
  code: string,
  params: Record<string, unknown> = {},
) {
  return t(code, {
    ...params,
    ...(params.field ? { field: fieldLabel(String(params.field)) } : {}),
    ...(params.action ? { action: t(`action.${params.action}`) } : {}),
  });
}
export function userMessage(error: unknown): string {
  if (error instanceof UserError) return errorMessage(error.code, error.params);
  if (error instanceof ZodError)
    return error.issues
      .map((i) =>
        t("error.invalidField", { field: fieldLabel(String(i.path[0])) }),
      )
      .join(" / ");
  const e = error as Error & { code?: string; path?: string };
  if (e?.code && e.path)
    return t("error.fileAccess", { code: e.code, path: e.path });
  return t("error.unexpected", { detail: e?.message ?? String(error) });
}
