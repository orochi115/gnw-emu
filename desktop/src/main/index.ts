import {
  initializeLocale,
  chooseLocale,
  t,
  userMessage,
  errorMessage,
  type Locale,
} from "../shared/locale";
import { UserError } from "../shared/user-error";
import { loadSettings, updateSettings } from "../core/settings-store";
import { ChassisPreference } from "../core/chassis-preference";
import { ViewSettings } from "../core/view-settings";
import { RecentRoms } from "../core/recent-roms";
import { SCALE_PRESETS, scaleMenuId } from "../shared/clock-geometry";
import { WindowMode } from "./window-mode";
import { menuTemplate, scaleMenuTemplate } from "./menu";
import type { AppState, ViewPreferences } from "../shared/contracts";
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
let preferences: ViewPreferences = { showChassis: true };
let preferenceChange: Promise<void> = Promise.resolve();
let viewPreference: ChassisPreference;
let windowMode: WindowMode;
let viewSettings: ViewSettings;
let recentRoms: RecentRoms;
let fittedModel: AppState["model"];
async function main() {
  const settings = await loadSettings(paths.userData);
  recentRoms = new RecentRoms(settings.recentRoms, (recentRoms) =>
    updateSettings(paths.userData, { recentRoms }),
  );
  preferences = { showChassis: settings.showChassis };
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
    width: 960,
    height: 640,
    useContentSize: true,
    frame: false,
    autoHideMenuBar: true,
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
  window.setMenuBarVisibility(false);
  viewSettings = new ViewSettings(
    async (patch) => {
      await updateSettings(paths.userData, patch);
      logger
        .child("view")
        .debug(
          { event: "view.settings.saved", ...patch },
          "Display preferences saved",
        );
    },
    (error) => {
      logger
        .child("view")
        .error(
          { event: "view.settings.failure", err: error },
          "Could not save display preferences",
        );
      if (!shuttingDown && !window.isDestroyed()) showError(error);
    },
  );
  windowMode = new WindowMode(
    window,
    (value) => {
      window.webContents.send("window.state", value);
      logger
        .child("view")
        .debug({ event: "window.state", ...value }, "Window state changed");
      updateMenu();
      uiEvents.emit("changed");
    },
    () => controller?.releaseInput(),
    () => controller.state.status === "running" && !shuttingDown,
    settings,
    (patch) => viewSettings.update(patch),
  );
  windowMode.setGameAvailable(false);
  controller = new SessionController({
    ...paths,
    logger: logger.child("session"),
    logFor: (module) => logger.child(module),
    createDisplay: (id) => startDisplay(window, id, logger.child("display")),
  });
  viewPreference = new ChassisPreference(settings.showChassis, {
    persist: (showChassis) => updateSettings(paths.userData, { showChassis }),
    release: () => {
      const id = controller.state.runtimeSessionId;
      if (id) controller.releaseChassis(id);
    },
    publish: async (value) => {
      preferences = value;
      await windowMode.fit(controller.state.model, value.showChassis);
      if (!window.isDestroyed())
        window.webContents.send("view.preferences", preferences);
      logger.child("view").info(
        {
          event: "chassis.visibility",
          ...value,
          runtimeSessionId: controller.state.runtimeSessionId,
        },
        "Device frame visibility changed",
      );
    },
  });
  dialogs = new DialogAdapter(
    window,
    argv.includes("--automation") && argv.includes("--test-dialogs"),
  );
  controller.on("state", (state) => {
    if (!window.isDestroyed()) {
      windowMode.setGameAvailable(
        ["starting", "running", "stopping"].includes(state.status),
      );
      if (state.model && state.model !== fittedModel) {
        fittedModel = state.model;
        void windowMode
          .fit(state.model, preferences.showChassis)
          .catch(showError);
      }
      if (
        !shuttingDown &&
        windowMode.state.clockMode &&
        ["idle", "error"].includes(state.status)
      )
        void windowMode.toggle(false).catch(showError);
      else restorePreferredClock();
      window.webContents.send("app.state", stateForUi(state));
      window.webContents.send("input.state", controller.inputState());
      window.setTitle(
        state.profileName ? `gnw-emu — ${state.profileName}` : "gnw-emu",
      );
      updateMenu();
    }
    uiEvents.emit("changed");
  });
  controller.on("input", (state) => {
    if (!window.isDestroyed()) window.webContents.send("input.state", state);
    uiEvents.emit("changed");
  });
  window.webContents.on("context-menu", () => {
    if (windowMode.state.clockMode)
      Menu.buildFromTemplate([
        {
          label: t("window.normal"),
          click: () => {
            void toggleClock().catch(showError);
          },
        },
        scaleMenuTemplate({
          pixelScale: windowMode.state.pixelScale,
          canScale: (factor) => canSetScale(factor),
          setScale: (factor) => {
            void setScale(factor).catch(showError);
          },
        }),
        {
          label: t("menu.quit"),
          click: () => {
            void shutdown();
          },
        },
      ]).popup({ window });
  });
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
    void perform(() => loadRom(resolve(file))).catch((e) => showError(e));
  logger
    .child("app")
    .info(
      { event: "ready", automation: !!automation, userData: paths.userData },
      "Application ready",
    );
}
function updateMenu() {
  const blocked =
    shuttingDown ||
    !!active ||
    makerOpen ||
    nativeDialog ||
    windowMode?.state.clockMode ||
    windowMode?.transitioning ||
    ["starting", "stopping"].includes(controller.state.status);
  const menu = Menu.getApplicationMenu();
  if (menu)
    for (const id of ["file.open", "file.make"]) {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = !blocked;
    }
  const recent = menu?.getMenuItemById("file.recent");
  if (recent) {
    recent.enabled = !blocked && recentRoms.entries.length > 0;
    for (const item of recent.submenu?.items ?? [])
      if (item.type !== "separator") item.enabled = recent.enabled;
  }
  const chassis = menu?.getMenuItemById("view.chassis");
  if (chassis) {
    chassis.checked = preferences.showChassis;
    chassis.enabled =
      !makerOpen && !nativeDialog && !active && !windowMode.transitioning;
  }
  for (const factor of SCALE_PRESETS) {
    const item = menu?.getMenuItemById(scaleMenuId(factor));
    if (item) {
      item.enabled = canSetScale(factor);
      // Electron radio setters select their item even when assigned false.
      // Select only the matching item; the native group clears the others.
      if (Math.abs(windowMode.state.pixelScale - factor) < 0.000001)
        item.checked = true;
    }
  }
  if (
    !SCALE_PRESETS.some(
      (factor) => Math.abs(windowMode.state.pixelScale - factor) < 0.000001,
    )
  ) {
    const custom = menu?.getMenuItemById("view.scale.custom");
    if (custom) custom.checked = true;
  }
  const zoom = menu?.getMenuItemById("window.zoom");
  if (zoom)
    zoom.enabled = !windowMode.state.clockMode && !windowMode.transitioning;
  const clock = menu?.getMenuItemById("view.clock");
  if (clock) {
    clock.checked = windowMode.state.clockMode;
    clock.enabled =
      !makerOpen &&
      !nativeDialog &&
      !active &&
      !windowMode.transitioning &&
      controller.state.status === "running";
  }
}
/** Queue toggles against the last committed preference; rollback native checks on failure. */
function toggleChassis() {
  const work = viewPreference.toggle().finally(() => {
    updateMenu();
    uiEvents.emit("changed");
  });
  preferenceChange = work;
  observedActivity = work;
  return work;
}
function restorePreferredClock() {
  if (
    !shuttingDown &&
    !active &&
    !makerOpen &&
    !nativeDialog &&
    controller.state.status === "running" &&
    windowMode.state.preferredClockMode &&
    !windowMode.state.clockMode &&
    !windowMode.transitioning
  )
    void windowMode
      .toggle(false)
      .then(() => {
        logger
          .child("view")
          .info(
            { event: "window.mode", reason: "preference", ...windowMode.state },
            "Restored preferred clock mode",
          );
      })
      .catch(showError);
}
function canSetScale(factor: number) {
  return (
    !makerOpen &&
    !nativeDialog &&
    !active &&
    !shuttingDown &&
    !windowMode.transitioning &&
    controller.state.status === "running" &&
    windowMode.canSetScale(factor)
  );
}
async function setScale(factor: number) {
  if (!canSetScale(factor)) throw new UserError("error.busy");
  await perform(() => windowMode.setScale(factor));
  await viewSettings.flush();
  logger
    .child("view")
    .info(
      { event: "window.scale", ...windowMode.state },
      "Pixel scale changed",
    );
}
async function toggleClock() {
  if (makerOpen || nativeDialog || shuttingDown)
    throw new UserError("error.busy");
  if (!windowMode.state.clockMode && controller.state.status !== "running")
    throw new UserError("error.busy");
  try {
    await perform(() => windowMode.toggle());
    await viewSettings.flush();
    logger.child("view").info(
      {
        event: "window.mode",
        ...windowMode.state,
        runtimeSessionId: controller.state.runtimeSessionId,
      },
      "Window mode changed",
    );
  } finally {
    updateMenu();
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
        recentRoms: recentRoms.entries,
        loadRecent: (path) => {
          void openRecent(path).catch(showError);
        },
        clearRecent: () => {
          void clearRecent().catch(showError);
        },
        showChassis: preferences.showChassis,
        clockMode: windowMode.state.clockMode,
        pixelScale: windowMode.state.pixelScale,
        setScale: (factor) => {
          void setScale(factor).catch(showError);
        },
        canScale: (factor) => canSetScale(factor),
        toggleClock: () => {
          void toggleClock().catch(showError);
        },
        toggleChassis: () => {
          void toggleChassis().catch(showError);
        },
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
  updateMenu();
  promise.catch(() => {});
  try {
    return await promise;
  } finally {
    if (active === promise) active = undefined;
    updateMenu();
    restorePreferredClock();
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
  if (windowMode.state.clockMode) throw new UserError("error.busy");
  return perform(async () => {
    const path = await native(() => dialogs.open(true));
    if (path) await loadRom(path);
  });
}
/** All successful host load routes record history, including CLI and Save and Load. */
async function loadRom(path: string) {
  await controller.load(path);
  try {
    await recentRoms.record(path);
    createMenu();
    updateMenu();
    logger
      .child("app")
      .info({ event: "recent.record", profilePath: path }, "Recent ROM saved");
  } catch (error) {
    showError(error as Error);
  }
}
function guardRecent() {
  if (
    makerOpen ||
    nativeDialog ||
    shuttingDown ||
    windowMode.state.clockMode ||
    windowMode.transitioning
  )
    throw new UserError("error.busy");
}
async function openRecent(path: string) {
  guardRecent();
  return perform(() => loadRom(path));
}
async function clearRecent() {
  guardRecent();
  return perform(async () => {
    await recentRoms.clear();
    createMenu();
    updateMenu();
    logger.child("app").info({ event: "recent.clear" }, "Recent ROMs cleared");
  });
}
function makeRom() {
  if (makerOpen || nativeDialog || active || windowMode.state.clockMode) return;
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
  ipcMain.handle("window.state", (event) => {
    trusted(event);
    return windowMode.state;
  });
  ipcMain.handle("window.action", async (event, action) => {
    trusted(event);
    switch (action) {
      case "menu":
        Menu.getApplicationMenu()?.popup({ window });
        break;
      case "minimize":
        window.minimize();
        break;
      case "maximize":
        if (!windowMode.state.clockMode)
          window.isMaximized() ? window.unmaximize() : window.maximize();
        break;
      case "normal":
        if (windowMode.state.clockMode) await toggleClock();
        break;
      case "close":
        window.close();
        break;
      default:
        throw new Error("Invalid window action");
    }
  });
  ipcMain.handle("view.preferences", (event) => {
    trusted(event);
    return preferences;
  });
  ipcMain.handle("input.state", (event) => {
    trusted(event);
    return controller.inputState();
  });
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
      if (load) await loadRom(path);
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
      (!down ||
        (!makerOpen &&
          !nativeDialog &&
          window.isFocused() &&
          !windowMode.transitioning))
    )
      controller.key(code, down);
  });
  ipcMain.on("input.release", (event) => {
    trusted(event);
    controller.releaseInput();
  });
  ipcMain.on("input.button", (event, bit, down, source, runtimeSessionId) => {
    trusted(event);
    if (
      Number.isInteger(bit) &&
      bit >= 0 &&
      bit <= 11 &&
      typeof down === "boolean" &&
      typeof source === "string" &&
      /^(pointer:\d{1,10}|chassis-key:[a-z]+:(Space|Enter))$/.test(source) &&
      typeof runtimeSessionId === "string" &&
      (!down ||
        (!makerOpen &&
          !nativeDialog &&
          preferences.showChassis &&
          window.isFocused() &&
          !windowMode.transitioning))
    )
      controller.button(bit, down, source, runtimeSessionId);
  });
  ipcMain.on("input.releaseChassis", (event, runtimeSessionId) => {
    trusted(event);
    if (typeof runtimeSessionId === "string")
      controller.releaseChassis(runtimeSessionId);
  });
  ipcMain.on("ui.modal", (event, open) => {
    trusted(event);
    if (typeof open === "boolean") {
      makerOpen = open;
      windowMode.setModal(open);
      if (!open) restorePreferredClock();
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
    case "ui.inspect": {
      const result = await ui.inspect();
      return { ...result, window: { ...result.window, ...windowMode.state } };
    }
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
    case "ui.pointer":
      return ui.pointer(params);
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
        chassis: (await ui.inspect()).chassis,
        window: {
          ...windowMode.state,
          alwaysOnTop: window.isAlwaysOnTop(),
          bounds: window.getBounds(),
        },
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
    await preferenceChange.catch(() => {});
    windowMode.flushPreferences();
    await viewSettings.flush();
    await controller.stop();
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "warning",
      message: t("error.saveTitle"),
      detail: userMessage(error),
      buttons: [t("menu.quit")],
    });
  } finally {
    await viewSettings.flush();
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
