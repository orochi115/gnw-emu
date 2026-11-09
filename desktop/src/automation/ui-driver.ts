import { BrowserWindow, Menu } from "electron";
import { writeFile } from "node:fs/promises";
import { RpcError } from "./server";
export class UiDriver {
  constructor(private window: BrowserWindow) {}
  private check() {
    if (this.window.isDestroyed()) throw new RpcError(-32004, "Window closed");
  }
  async inspect() {
    this.check();
    const dom = await this.window.webContents.executeJavaScript(
      `({dialogOpen:!!document.querySelector('dialog[open]'),status:document.querySelector('main')?.dataset.status,controls:Array.from(document.querySelectorAll('[data-ui]')).map(e=>({id:e.dataset.ui,role:e.getAttribute('role')||e.tagName.toLowerCase(),label:e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.innerText?.slice(0,160),value:e.value,disabled:!!e.disabled,visible:!!e.getClientRects().length,invalid:e.getAttribute('aria-invalid')})),canvas:(()=>{const e=document.querySelector('canvas');return e?{...e.dataset,width:e.width,height:e.height,displayWidth:e.clientWidth,displayHeight:e.clientHeight}:null})()})`,
    );
    return {
      ...dom,
      window: {
        title: this.window.getTitle(),
        bounds: this.window.getBounds(),
        focused: this.window.isFocused(),
      },
      menus: Menu.getApplicationMenu()?.items.flatMap(
        (item) =>
          item.submenu?.items.map((v) => ({
            id: v.id,
            label: v.label,
            enabled: v.enabled,
          })) ?? [],
      ),
    };
  }
  private async control(id: string) {
    this.check();
    if (!/^[a-zA-Z0-9.]+$/.test(id))
      throw new RpcError(-32602, "Invalid control ID");
    const info = await this.window.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify('[data-ui="')}+${JSON.stringify(id)}+${JSON.stringify('"]')});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:!!e.getClientRects().length,disabled:!!e.disabled,tag:e.tagName,insideModal:!!e.closest('dialog[open]'),modal:!!document.querySelector('dialog[open]')};})()`,
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
    if (info.tag !== "INPUT")
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
  async menu(id: string) {
    this.check();
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById(id);
    if (!item || !item.enabled)
      throw new RpcError(-32003, "Menu disabled or missing");
    item.click(undefined, this.window, undefined);
    return { menu: id, boundary: "native Menu handler" };
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
