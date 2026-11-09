import { contextBridge, ipcRenderer } from "electron";
const subscribe = (channel: string, callback: (value: any) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: any) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("desktop", {
  windowState: () => ipcRenderer.invoke("window.state"),
  onWindowState: (cb: (v: unknown) => void) => subscribe("window.state", cb),
  windowAction: (action: string) => ipcRenderer.invoke("window.action", action),
  locale: () => ipcRenderer.invoke("app.locale"),
  state: () => ipcRenderer.invoke("app.state"),
  onState: (cb: (v: unknown) => void) => subscribe("app.state", cb),
  preferences: () => ipcRenderer.invoke("view.preferences"),
  onPreferences: (cb: (v: unknown) => void) =>
    subscribe("view.preferences", cb),
  inputState: () => ipcRenderer.invoke("input.state"),
  onInput: (cb: (v: unknown) => void) => subscribe("input.state", cb),
  button: (
    bit: number,
    down: boolean,
    source: string,
    runtimeSessionId: string,
  ) => ipcRenderer.send("input.button", bit, down, source, runtimeSessionId),
  releaseChassis: (id: string) => ipcRenderer.send("input.releaseChassis", id),
  onMake: (cb: () => void) => subscribe("ui.make", cb),
  openRom: () => ipcRenderer.invoke("rom.open"),
  makeRom: () => ipcRenderer.invoke("rom.make"),
  pickImage: (field: string) => ipcRenderer.invoke("rom.pick", field),
  saveRom: (fields: unknown, load: boolean) =>
    ipcRenderer.invoke("rom.save", fields, load),
  key: (code: string, down: boolean) =>
    ipcRenderer.send("input.key", code, down),
  releaseInput: () => ipcRenderer.send("input.release"),
  modal: (open: boolean) => ipcRenderer.send("ui.modal", open),
  log: (level: string, event: string, fields: unknown) =>
    ipcRenderer.send("log.renderer", level, event, fields),
});
ipcRenderer.on("display-port", (event, data) =>
  window.postMessage(
    { type: "gnw-display", runtimeSessionId: data.runtimeSessionId },
    "*",
    event.ports,
  ),
);
