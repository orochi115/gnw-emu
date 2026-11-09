import { t } from "../shared/locale";
import { dialog, type BrowserWindow } from "electron";
import { RpcError } from "./server";
export class DialogAdapter {
  private queue: { kind: "open" | "save"; path: string | null }[] = [];
  constructor(
    private window: BrowserWindow,
    private testMode: boolean,
  ) {}
  enqueue(response: { kind: "open" | "save"; path: string | null }) {
    if (!this.testMode) throw new RpcError(-32003, "Test dialogs are disabled");
    if (
      !["open", "save"].includes(response.kind) ||
      (response.path !== null && typeof response.path !== "string")
    )
      throw new RpcError(-32602, "Invalid dialog response");
    if (this.queue.length >= 20)
      throw new RpcError(-32001, "Dialog queue full");
    this.queue.push(response);
    return { queued: this.queue.length };
  }
  async open(profile = false) {
    if (this.queue.length) {
      const next = this.queue.shift()!;
      if (next.kind !== "open")
        throw new Error("Expected open dialog response");
      return next.path;
    }
    const result = await dialog.showOpenDialog(this.window, {
      title: t(profile ? "dialog.open" : "dialog.image"),
      properties: ["openFile"],
      ...(profile
        ? { filters: [{ name: t("rom.profile"), extensions: ["gnw.json"] }] }
        : {}),
    });
    return result.canceled ? null : result.filePaths[0];
  }
  async save() {
    if (this.queue.length) {
      const next = this.queue.shift()!;
      if (next.kind !== "save")
        throw new Error("Expected save dialog response");
      return next.path;
    }
    const result = await dialog.showSaveDialog(this.window, {
      title: t("dialog.save"),
      defaultPath: "game.gnw.json",
      filters: [{ name: t("rom.profile"), extensions: ["gnw.json"] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  }
}
