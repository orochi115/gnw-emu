import { app, BrowserWindow, Menu } from "electron";
import { writeFile } from "node:fs/promises";
import { RpcError } from "./server";
function menuItems(menu?: Electron.Menu): Record<string, unknown>[] {
  return (
    menu?.items.flatMap((item) => [
      {
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        type: item.type,
        checked:
          item.type === "checkbox" || item.type === "radio"
            ? item.checked
            : undefined,
      },
      ...menuItems(item.submenu),
    ]) ?? []
  );
}
export class UiDriver {
  constructor(
    private mainWindow: BrowserWindow,
    private contextMenu?: () => Electron.Menu | undefined,
    private settingsWindow?: () => BrowserWindow | undefined,
  ) {}
  private get window() {
    return this.settingsWindow?.() ?? this.mainWindow;
  }
  private check() {
    if (this.window.isDestroyed()) throw new RpcError(-32004, "Window closed");
  }
  async inspect() {
    this.check();
    const dom = await this.window.webContents.executeJavaScript(
      `({locale:document.documentElement.lang,dialogOpen:!!document.querySelector('dialog[open], [data-ui=\"controls.dialog\"]'),status:document.querySelector('main')?.dataset.status,controls:Array.from(document.querySelectorAll('[data-ui]')).map(e=>({id:e.dataset.ui,role:e.getAttribute('role')||e.tagName.toLowerCase(),label:e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.innerText?.slice(0,160),value:e.value,checked:e.type==="radio"?e.checked:undefined,pressed:e.getAttribute('aria-pressed'),disabled:!!e.disabled,visible:!!e.getClientRects().length,invalid:e.getAttribute('aria-invalid')})),chassis:(()=>{const e=document.querySelector('[data-ui="chassis"]');const main=document.querySelector('main');return {visible:!!e?.getClientRects().length,model:e?.dataset.model,input:{desiredMask:Number(main?.dataset.desiredMask||0),appliedMask:Number(main?.dataset.appliedMask||0)}}})(),canvas:(()=>{const e=document.querySelector('canvas');const r=e?.getBoundingClientRect();return e?{...e.dataset,width:e.width,height:e.height,displayWidth:r.width,displayHeight:r.height,displayX:r.x,displayY:r.y,devicePixelRatio:window.devicePixelRatio,pixelScale:r.width*window.devicePixelRatio/e.width}:null})()})`,
    );
    return {
      ...dom,
      window: {
        title: this.window.getTitle(),
        bounds: this.window.getBounds(),
        contentBounds: this.window.getContentBounds(),
        alwaysOnTop: this.window.isAlwaysOnTop(),
        focused: this.window.isFocused(),
      },
      menus: menuItems(Menu.getApplicationMenu() ?? undefined),
      contextMenus: menuItems(this.contextMenu?.()),
    };
  }
  private async control(id: string) {
    this.check();
    if (!/^[a-zA-Z0-9.:-]+$/.test(id))
      throw new RpcError(-32602, "Invalid control ID");
    const info = await this.window.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify('[data-ui="')}+${JSON.stringify(id)}+${JSON.stringify('"]')});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:!!e.getClientRects().length,disabled:!!e.disabled,tag:e.tagName,inputType:e.type,insideModal:!!e.closest('dialog[open]'),modal:!!document.querySelector('dialog[open]')};})()`,
    );
    if (!info || !info.visible)
      throw new RpcError(-32004, "Control not visible");
    if (info.disabled) throw new RpcError(-32003, "Control disabled");
    if (info.modal && !info.insideModal)
      throw new RpcError(-32003, "Control blocked by modal");
    return info;
  }
  private async settle() {
    await this.window.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
  }
  async click(id: string) {
    const info = await this.control(id);
    this.window.focus();
    this.window.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      x: Math.round(info.x),
      y: Math.round(info.y),
    });
    this.window.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: Math.round(info.x),
      y: Math.round(info.y),
    });
    await this.settle();
    return { clicked: id };
  }
  async fill(id: string, value: string) {
    if (typeof value !== "string" || value.length > 8192)
      throw new RpcError(-32602, "Invalid field value");
    const info = await this.control(id);
    if (
      info.tag !== "INPUT" ||
      !["text", "search", "url", "email", "tel", "password"].includes(
        info.inputType,
      )
    )
      throw new RpcError(-32602, "Control is not a text input");
    await this.click(id);
    this.window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "A",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    this.window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "A",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    await this.settle();
    await this.window.webContents.insertText(value);
    await this.settle();
    return { filled: id };
  }
  async select(id: string, value: string) {
    const info = await this.control(id);
    if (info.tag !== "SELECT")
      throw new RpcError(-32602, "Control is not a select");
    await this.window.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify('[data-ui="')}+${JSON.stringify(id)}+${JSON.stringify('"]')});if(!Array.from(e.options).some(o=>o.value===${JSON.stringify(value)}))throw Error('Invalid option');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await this.settle();
    return { selected: id };
  }
  async menu(id: string, context = false) {
    this.check();
    const menu = context ? this.contextMenu?.() : Menu.getApplicationMenu();
    const item = menu?.getMenuItemById(id);
    if (!item || !item.enabled)
      throw new RpcError(-32003, "Menu disabled or missing");
    // macOS executes built-in roles in native code; MenuItem.click alone
    // only invokes JavaScript handlers. Use the corresponding Electron
    // native command without bypassing window close/before-quit lifecycle.
    switch (item.role?.toLowerCase()) {
      case "quit":
        app.quit();
        break;
      case "close":
        this.window.close();
        break;
      case "minimize":
        this.window.minimize();
        break;
      case "zoom":
        this.window.isMaximized()
          ? this.window.unmaximize()
          : this.window.maximize();
        break;
      case "front":
        for (const window of BrowserWindow.getAllWindows()) window.show();
        break;
      case "undo":
        this.window.webContents.undo();
        break;
      case "redo":
        this.window.webContents.redo();
        break;
      case "cut":
        this.window.webContents.cut();
        break;
      case "copy":
        this.window.webContents.copy();
        break;
      case "paste":
        this.window.webContents.paste();
        break;
      case "selectall":
        this.window.webContents.selectAll();
        break;
      default:
        if (item.type === "checkbox") item.checked = !item.checked;
        item.click(undefined, this.window, undefined);
    }
    return {
      menu: id,
      boundary: item.role ? "native role command" : "native Menu handler",
    };
  }
  async key(key: string, down: boolean) {
    this.check();
    if (typeof key !== "string" || key.length > 32)
      throw new RpcError(-32602, "Invalid key");
    this.window.focus();
    this.window.webContents.sendInputEvent({
      type: down ? "keyDown" : "keyUp",
      keyCode: key,
    });
    await this.settle();
    return { key, down };
  }
  async pointer(params: {
    id?: string;
    phase: "down" | "up";
    x?: number;
    y?: number;
  }) {
    this.check();
    const info = params.id
      ? await this.control(params.id)
      : { x: params.x!, y: params.y! };
    this.window.focus();
    this.window.webContents.sendInputEvent({
      type: params.phase === "down" ? "mouseDown" : "mouseUp",
      button: "left",
      clickCount: 1,
      x: Math.round(info.x),
      y: Math.round(info.y),
    });
    await this.settle();
    return { phase: params.phase, id: params.id };
  }
  async screenshot(path: string) {
    this.check();
    if (typeof path !== "string" || !path.endsWith(".png"))
      throw new RpcError(-32602, "Expected PNG path");
    const image = await this.window.webContents.capturePage();
    await writeFile(path, image.toPNG());
    return {
      path,
      width: image.getSize().width,
      height: image.getSize().height,
    };
  }
}
