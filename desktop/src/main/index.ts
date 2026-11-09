import {
  initializeLocale,
  chooseLocale,
  t,
  userMessage,
  errorMessage,
  type Locale,
} from "../shared/locale";
import { UserError } from "../shared/user-error";
import { loadSettings } from "../core/settings-store";
import { menuTemplate } from "./menu";
import type { AppState } from "../shared/contracts";
import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { EventEmitter } from "node:events";
import { applicationPaths } from "../core/paths";
import { SessionController } from "../core/session-controller";
import { createProfile } from "../core/profile-store";
import { profileSchema } from "../core/schemas";
import { startDisplay } from "./display-adapter";
import { createLogManager } from "../observability/logger";
import { DialogAdapter } from "../automation/dialog-adapter";
import { UiDriver } from "../automation/ui-driver";
import { startAutomationServer, RpcError } from "../automation/server";
const __dirname = import.meta.dirname;
const argv = process.argv;
const override = argv
  .find((v) => v.startsWith("--user-data-dir="))
  ?.slice("--user-data-dir=".length);
const paths = applicationPaths({
  packaged: app.isPackaged,
  resources: process.resourcesPath,
  project: resolve(__dirname, "../../.."),
  osUserData: app.getPath("userData"),
  override,
});
mkdirSync(join(paths.userData, "electron-host"), { recursive: true });
app.setPath("userData", join(paths.userData, "electron-host"));
const instanceId = randomUUID();
let window: BrowserWindow;
let shuttingDown = false;
let makerOpen = false;
let nativeDialog = false;
let automation: Awaited<ReturnType<typeof startAutomationServer>> | undefined;
let controller: SessionController;
let dialogs: DialogAdapter;
let logger: ReturnType<typeof createLogManager>;
let active: Promise<unknown> | undefined;
let observedActivity: Promise<unknown> | undefined;
const uiEvents = new EventEmitter();
let bridgeDropped = 0;
let locale: Locale = "en";
let closeLogs: () => Promise<void> = async () => {};
async function main() {
  const settings = await loadSettings(paths.userData);
  locale = chooseLocale(
    app.getLocale(),
    settings.language,
    argv.find((v) => v.startsWith("--language="))?.slice(11),
  );
  initializeLocale(locale);
  app.setAboutPanelOptions({
    applicationName: "gnw-emu",
    applicationVersion: app.getVersion(),
  });
  const rotation = pino.transport({
    target: "pino-roll",
    options: {
      file: join(paths.userData, "logs", "desktop.jsonl"),
      size: "10m",
      frequency: "daily",
      mkdir: true,
      limit: { count: 5, removeOtherLogFiles: true },
    },
  });
  let transportFailed = false;
  rotation.on("error", (error) => {
    transportFailed = true;
    process.stderr.write(
      JSON.stringify({
        level: 50,
        event: "log.transport.failure",
        message: error.message,
      }) + "\n",
    );
  });
  const pretty = argv.includes("--log-pretty")
    ? pino.transport({
        target: "pino-pretty",
        options: { destination: 2, colorize: true },
      })
    : undefined;
  const sink = new Writable({
    write(chunk, _e, done) {
      if (pretty) pretty.write(chunk);
      else process.stderr.write(chunk);
      if (!transportFailed) rotation.write(chunk);
      done();
    },
  });
  closeLogs = async () => {
    for (const transport of [rotation, pretty]) {
      if (
        !transport ||
        (transport as unknown as { destroyed?: boolean }).destroyed === true
      )
        continue;
      await new Promise<void>((resolve) => {
        transport.once("close", resolve);
        transport.end();
      });
    }
  };
  logger = createLogManager({
    appInstanceId: instanceId,
    destination: sink,
    level: argv.includes("--debug") ? "debug" : "info",
  });
  window = new BrowserWindow({
    width: 640,
    height: 480,
    useContentSize: true,
    minWidth: 320,
    minHeight: 280,
    title: "gnw-emu",
    backgroundColor: "#111318",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  controller = new SessionController({
    ...paths,
    logger: logger.child("session"),
    logFor: (module) => logger.child(module),
    createDisplay: (id) => startDisplay(window, id, logger.child("display")),
  });
  dialogs = new DialogAdapter(
    window,
    argv.includes("--automation") && argv.includes("--test-dialogs"),
  );
  controller.on("state", (state) => {
    if (!window.isDestroyed()) {
      window.webContents.send("app.state", stateForUi(state));
      window.setTitle(
        state.profileName ? `gnw-emu — ${state.profileName}` : "gnw-emu",
      );
      updateMenu();
    }
    uiEvents.emit("changed");
  });
  window.on("blur", () => controller.releaseInput());
  window.webContents.on("before-input-event", (_e, input) => {
    if (input.control || input.meta || input.alt || input.key === "F10")
      controller.releaseInput();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      void shutdown();
    }
  });
  window.once("ready-to-show", () => window.show());
  createMenu();
  registerIpc();
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
  if (argv.includes("--automation"))
    automation = await startAutomationServer({
      directory: paths.userData,
      instanceId,
      dispatch,
    });
  const file = argv.find((v) => v.endsWith(".gnw.json"));
  if (file)
    void perform(() => controller.load(resolve(file))).catch((e) =>
      showError(e),
    );
  logger
    .child("app")
    .info(
      { event: "ready", automation: !!automation, userData: paths.userData },
      "Application ready",
    );
}
function updateMenu() {
  const blocked =
    makerOpen ||
    nativeDialog ||
    ["starting", "stopping"].includes(controller.state.status);
  const menu = Menu.getApplicationMenu();
  if (menu)
    for (const id of ["file.open", "file.make"]) {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = !blocked;
    }
}
function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(process.platform, {
        open: () => {
          void openRom().catch(showError);
        },
        make: () => makeRom(),
      }),
    ),
  );
}
function stateForUi(state: AppState): AppState {
  return {
    ...state,
    ...(state.error
      ? {
          error: state.errorCode
            ? errorMessage(state.errorCode, state.errorParams)
            : userMessage(new Error(state.error)),
        }
      : {}),
  };
}
async function perform<T>(work: () => Promise<T>): Promise<T> {
  if (active) throw new UserError("error.busy");
  const promise = work();
  active = promise;
  observedActivity = promise;
  promise.catch(() => {});
  try {
    return await promise;
  } finally {
    if (active === promise) active = undefined;
  }
}
async function native<T>(work: () => Promise<T>) {
  if (nativeDialog) throw new UserError("error.dialogBusy");
  nativeDialog = true;
  controller.releaseInput();
  updateMenu();
  try {
    return await work();
  } finally {
    nativeDialog = false;
    updateMenu();
    window.webContents.focus();
  }
}
async function openRom() {
  if (makerOpen) throw new UserError("error.makerOpen");
  return perform(async () => {
    const path = await native(() => dialogs.open(true));
    if (path) await controller.load(path);
  });
}
function makeRom() {
  if (makerOpen || nativeDialog || active) return;
  controller.releaseInput();
  makerOpen = true;
  updateMenu();
  window.webContents.send("ui.make");
}
function showError(error: Error) {
  logger
    .child("app")
    .error({ err: error, event: "operation.failure" }, "Operation failed");
  if (!window.isDestroyed())
    window.webContents.send("app.state", {
      ...controller.state,
      status:
        controller.state.status === "idle" ||
        controller.state.status === "error"
          ? "error"
          : controller.state.status,
      error: userMessage(error),
    });
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Unauthorized renderer");
}
function registerIpc() {
  ipcMain.handle("app.locale", (event) => {
    trusted(event);
    return locale;
  });
  ipcMain.handle("app.state", (event) => {
    trusted(event);
    return stateForUi(controller.state);
  });
  ipcMain.handle("rom.open", (event) => {
    trusted(event);
    return openRom().catch((error) => {
      showError(error);
      throw new Error(userMessage(error));
    });
  });
  ipcMain.handle("rom.make", (event) => {
    trusted(event);
    makeRom();
  });
  ipcMain.handle("rom.pick", async (event, field) => {
    trusted(event);
    if (
      !makerOpen ||
      !["internalFlash", "externalFlash", "bank2Flash", "sdCard"].includes(
        field,
      )
    )
      throw new Error("Invalid image field");
    return perform(() => native(() => dialogs.open()));
  });
  ipcMain.handle("rom.save", async (event, fields, load) => {
    trusted(event);
    if (!makerOpen || typeof load !== "boolean")
      throw new Error("Invalid save request");
    return perform(async () => {
      let validated;
      try {
        validated = profileSchema.parse({
          ...fields,
          formatVersion: 1,
          id: randomUUID(),
        });
      } catch (error) {
        throw new Error(userMessage(error));
      }
      const dest = await native(() => dialogs.save());
      if (!dest) return { saved: false };
      const path = dest.endsWith(".gnw.json") ? dest : dest + ".gnw.json";
      const { formatVersion, id, ...values } = validated;
      await createProfile(path, values);
      if (load) await controller.load(path);
      return { saved: true, path };
    }).catch((error) => {
      throw new Error(userMessage(error));
    });
  });
  ipcMain.on("input.key", (event, code, down) => {
    trusted(event);
    if (
      typeof code === "string" &&
      typeof down === "boolean" &&
      !makerOpen &&
      !nativeDialog
    )
      controller.key(code, down);
  });
  ipcMain.on("input.release", (event) => {
    trusted(event);
    controller.releaseInput();
  });
  ipcMain.on("ui.modal", (event, open) => {
    trusted(event);
    if (typeof open === "boolean") {
      makerOpen = open;
      controller.releaseInput();
      updateMenu();
      uiEvents.emit("changed");
    }
  });
  ipcMain.on("ui.changed", (event) => {
    trusted(event);
    uiEvents.emit("changed");
  });
  let bridgeCount = 0;
  setInterval(() => {
    bridgeCount = 0;
  }, 1000).unref();
  ipcMain.on("log.renderer", (event, level, name, fields) => {
    trusted(event);
    if (++bridgeCount > 40) {
      bridgeDropped++;
      return;
    }
    if (
      !["debug", "info", "warn", "error"].includes(level) ||
      typeof name !== "string"
    )
      return;
    let serialized = "";
    try {
      serialized = JSON.stringify(fields);
    } catch {
      return;
    }
    if (serialized.length > 8192) {
      bridgeDropped++;
      return;
    }
    logger.child("renderer")[level as "info"](
      {
        ...fields,
        event: name,
        source: "renderer",
        module: "renderer",
        appInstanceId: instanceId,
      },
      name,
    );
  });
}
const waiters = new Map<string, () => void>();
async function dispatch(method: string, params: any) {
  logger.child("automation").debug(
    {
      event: "request",
      operationId: params.operationId,
      method,
      runtimeSessionId: controller.state.runtimeSessionId,
    },
    "Automation request",
  );
  const ui = new UiDriver(window);
  if (
    params.runtimeSessionId &&
    params.runtimeSessionId !== controller.state.runtimeSessionId
  )
    throw new RpcError(-32005, "Stale runtime session");
  switch (method) {
    case "ui.inspect":
      return ui.inspect();
    case "ui.click": {
      observedActivity = undefined;
      const result = await ui.click(params.id);
      if (observedActivity) await observedActivity;
      return result;
    }
    case "ui.fill":
      return ui.fill(params.id, params.value);
    case "ui.select":
      return ui.select(params.id, params.value);
    case "ui.key":
      return ui.key(params.key, params.down !== false);
    case "ui.menu": {
      observedActivity = undefined;
      const result = await ui.menu(params.id);
      if (observedActivity) await observedActivity;
      return result;
    }
    case "ui.screenshot":
      return ui.screenshot(params.path);
    case "app.getState":
      return stateForUi(controller.state);
    case "app.getDiagnostics":
      return {
        ...controller.diagnostics(),
        ...((await ui.inspect()).canvas ?? {}),
        memory: process.memoryUsage(),
        instanceId,
        logBridge: { dropped: bridgeDropped },
      };
    case "automation.queueDialogResponse":
      return dialogs.enqueue(params);
    case "logging.getConfig":
      return logger.getConfig();
    case "logging.configure": {
      const levels = [
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
        "silent",
      ];
      if (
        (params.level && !levels.includes(params.level)) ||
        (params.modules &&
          Object.values(params.modules).some(
            (v) => !levels.includes(String(v)),
          ))
      )
        throw new RpcError(-32602, "Invalid log levels");
      return logger.configure(params);
    }
    case "logging.tail":
      return logger.tail(params);
    case "automation.cancelWait": {
      waiters.get(params.waitId)?.();
      return { cancelled: true };
    }
    case "ui.waitFor": {
      if (
        !["app.status", "ui.dialogOpen", "ui.lastPresented"].includes(
          params.condition,
        )
      )
        throw new RpcError(-32602, "Unknown wait condition");
      const waitId = params.waitId ?? randomUUID();
      if (waiters.has(waitId)) throw new RpcError(-32001, "Duplicate wait ID");
      return new Promise((resolve, reject) => {
        let checking = false;
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          clearInterval(poll);
          uiEvents.removeListener("changed", check);
          waiters.delete(waitId);
          if (error) reject(error);
          else resolve(value);
        };
        const check = async () => {
          if (checking) return;
          checking = true;
          try {
            const value =
              params.condition === "app.status"
                ? controller.state.status
                : params.condition === "ui.dialogOpen"
                  ? (await ui.inspect()).dialogOpen
                  : (await ui.inspect()).canvas?.lastPresented;
            if (
              params.condition === "ui.lastPresented"
                ? value && BigInt(value) >= BigInt(params.value ?? 1)
                : value === params.value
            )
              finish(undefined, { waitId, value });
          } catch (e) {
            finish(e as Error);
          } finally {
            checking = false;
          }
        };
        const timer = setTimeout(
          () => finish(new RpcError(-32002, "Wait timed out")),
          Math.min(Math.max(params.timeoutMs ?? 10000, 1), 60000),
        );
        const poll = setInterval(check, 200);
        uiEvents.on("changed", check);
        waiters.set(waitId, () =>
          finish(new RpcError(-32006, "Wait cancelled")),
        );
        void check();
      });
    }
    default:
      throw new RpcError(-32601, "Unsupported method");
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await active?.catch(() => {});
    await controller.stop();
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "warning",
      message: t("error.saveTitle"),
      detail: userMessage(error),
      buttons: [t("menu.quit")],
    });
  } finally {
    for (const cancel of waiters.values()) cancel();
    await automation?.close();
    await closeLogs();
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app
    .whenReady()
    .then(main)
    .catch((error) => {
      process.stderr.write(String(error) + "\n");
      app.exit(1);
    });
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", (event) => {
    if (!shuttingDown && controller) {
      event.preventDefault();
      void shutdown();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
