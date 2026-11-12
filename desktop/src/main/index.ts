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
import { AudioPreference } from "../core/audio-preference";
import { ControlWindow } from "./control-window";
import type { ControlPage } from "./control-window-geometry";
import { ControlRouter } from "../core/control-router";
import { ControlSettingsTransaction } from "../core/control-settings-transaction";
import {
  controlInputSchema,
  controlsSchema,
  gamepadParticipationSchema,
  type GamepadParticipation,
  type ControlsSettings,
  type HotkeyAction,
} from "../shared/controls";
import type { DockCorner } from "../shared/dock-geometry";
import { SCALE_PRESETS, scaleMenuId } from "../shared/clock-geometry";
import { WindowMode } from "./window-mode";
import { menuTemplate, clockMenuTemplate, deviceMenuItems } from "./menu";
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
import { startManagerSessionServer } from "../core/manager-session-server";
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
  // Electron applies --user-data-dir before this module runs. Validate against
  // the product's default location, rather than the already redirected path.
  osUserData: override
    ? join(app.getPath("appData"), app.getName())
    : app.getPath("userData"),
  override,
  kernel: process.env.GNW_KERNEL,
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
let managerService:
  Awaited<ReturnType<typeof startManagerSessionServer>> | undefined;
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
let audioPreference: AudioPreference;
let fittedModel: AppState["model"];
let controlRouter: ControlRouter;
let controlSettings: ControlSettingsTransaction;
let routedSessionId: string | undefined;
let rendererReady = true;
let controlHost: ControlWindow;
let controlParticipation: GamepadParticipation[] = [];
let lastControlModel: "mario" | "zelda" = "zelda";
function publishInputEpoch() {
  if (!controlRouter) return;
  for (const host of [window, controlHost?.window])
    if (host && !host.isDestroyed())
      host.webContents.send("input.epoch", controlRouter.epoch);
}
function syncControlBlock() {
  if (!controlRouter || !controller) return;
  const epoch = controlRouter.epoch;
  controlRouter.setBlocked(
    !!controlSettings?.opened ||
      !rendererReady ||
      makerOpen ||
      nativeDialog ||
      shuttingDown ||
      !window.isFocused() ||
      windowMode.transitioning ||
      ["starting", "stopping"].includes(controller.state.status) ||
      !!controller.state.deviceOperation ||
      !!controller.state.stateOperation,
    controller.state.execution,
  );
  if (epoch !== controlRouter.epoch) publishInputEpoch();
}
async function runControlAction(id: HotkeyAction) {
  if (
    controlSettings.opened ||
    makerOpen ||
    nativeDialog ||
    shuttingDown ||
    !window.isFocused()
  )
    return;
  switch (id) {
    case "file.open":
      await openRom();
      break;
    case "file.make":
      makeRom();
      break;
    case "view.chassis":
      await toggleChassis();
      break;
    case "view.clock":
      await toggleClock();
      break;
    case "state.save":
      await controller.instantState("save");
      break;
    case "state.load":
      await controller.instantState("load");
      break;
    case "state.previousSlot":
    case "state.nextSlot":
      controller.selectStateSlot(
        ((controller.state.stateSlot ?? 0) +
          (id === "state.nextSlot" ? 1 : 9)) %
          10,
      );
      break;
    case "audio.mute":
      await toggleMute();
      break;
    default:
      observedActivity = controller.deviceAction(id);
      await observedActivity;
      break;
  }
}
async function openControlSettings(page: ControlPage = "buttons") {
  if (controlSettings.opened) {
    controlHost.window?.focus();
    return;
  }
  if (
    !rendererReady ||
    makerOpen ||
    nativeDialog ||
    active ||
    shuttingDown ||
    windowMode.transitioning
  )
    throw new UserError("error.busy");
  const opening = controlSettings.open();
  const revision = controlSettings.revision;
  const config = await opening;
  try {
    if (!controlSettings.isOpen(revision) || !rendererReady)
      throw new UserError("error.busy");
    await controlHost.open(page);
    if (!controlSettings.isOpen(revision) || !rendererReady) {
      controlHost.destroy();
      throw new UserError("error.busy");
    }
    window.webContents.send("controls.open", {
      config,
      epoch: controlRouter.epoch,
    });
    logger
      .child("input")
      .info(
        { event: "controls.open", epoch: controlRouter.epoch },
        "Control configuration opened",
      );
  } catch (error) {
    if (controlSettings.isOpen(revision)) controlSettings.close();
    throw error;
  }
}
function controlsClosed() {
  controlSettings.abandon();
  controlRouter.releaseDevice("capture:");
  if (!window.isDestroyed()) {
    window.webContents.send("controls.closed");
    if (!shuttingDown) window.focus();
  }
  syncControlBlock();
  publishInputEpoch();
  updateMenu();
}
function closeControlSettings() {
  controlSettings.close();
  controlHost.destroy();
}
function controlAccelerators(
  config: ControlsSettings,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const id of ["file.open", "file.make"]) {
    const binding = config.bindings.find(
      (b) => b.target === id && b.inputs[0]?.kind === "keyboard",
    );
    const key = binding?.inputs[0];
    if (!binding || key?.kind !== "keyboard") {
      result[id] = undefined;
      continue;
    }
    const modifiers = binding.modifiers.map((m) =>
      m === "Control" ? "Ctrl" : m === "Meta" ? "Command" : m,
    );
    const code = key.code.replace(/^Key|^Digit/, "");
    result[id] = [
      ...modifiers,
      code === "ArrowUp"
        ? "Up"
        : code === "ArrowDown"
          ? "Down"
          : code === "ArrowLeft"
            ? "Left"
            : code === "ArrowRight"
              ? "Right"
              : code,
    ].join("+");
  }
  return result;
}
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
    () => {
      controlRouter?.reset();
      controller?.releaseInput();
      publishInputEpoch();
    },
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
  if (paths.kernel === "gwemu") {
    if (process.platform === "win32") {
      logger
        .child("session")
        .warn(
          { event: "manager.unsupported" },
          "Current-session management requires Unix sockets",
        );
      void dialog.showMessageBox(window, {
        type: "info",
        message: t("manager.unsupportedTitle"),
        detail: t("manager.unsupportedPlatform"),
      });
    } else {
      managerService = await startManagerSessionServer({ controller });
      logger.child("session").info(
        {
          event: "manager.started",
          serverId: managerService.descriptor.serverId,
        },
        "Current-session management service started",
      );
    }
  }
  controlRouter = new ControlRouter(settings.controls, {
    button: (bit, down, source) => {
      const id = controller.state.runtimeSessionId;
      if (id) controller.button(bit, down, source, id);
    },
    release: () => controller.releaseInput(),
    physicalRelease: () => controller.releasePhysicalInput(),
    flush: () => controller.flushInput(),
    action: (id) => {
      void runControlAction(id).catch(showError);
    },
    failed: (error) =>
      logger
        .child("input")
        .error(
          { event: "turbo.failure", err: error },
          "Input scheduler failed",
        ),
  });
  controlSettings = new ControlSettingsTransaction(settings.controls, {
    block: () => {
      syncControlBlock();
      updateMenu();
    },
    flush: () => controller.flushInput(),
    persist: (controls) => updateSettings(paths.userData, { controls }),
    apply: (controls) => {
      controlRouter.setConfig(controls);
      for (const host of [window, controlHost?.window])
        if (host && !host.isDestroyed())
          host.webContents.send("controls.changed", controls);
      publishInputEpoch();
      createMenu();
    },
  });
  controlHost = new ControlWindow({
    parent: window,
    preload: join(__dirname, "../preload/index.cjs"),
    renderer: join(__dirname, "../renderer/index.html"),
    devUrl: process.env.ELECTRON_RENDERER_URL,
    title: (page) =>
      t(page === "buttons" ? "menu.controls" : "menu.hotkeys").replace(
        /…$/,
        "",
      ),
    canClose: () => {
      try {
        controlSettings.close();
        return true;
      } catch {
        return false;
      }
    },
    closed: controlsClosed,
  });
  audioPreference = new AudioPreference(settings.audio, {
    apply: (enabled) => controller.setMuted(!enabled),
    persist: (audio) => updateSettings(paths.userData, { audio }),
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
    if (state.model) lastControlModel = state.model;
    if (state.runtimeSessionId !== routedSessionId) {
      routedSessionId = state.runtimeSessionId;
      controlRouter.reset();
      publishInputEpoch();
    }
    syncControlBlock();
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
  controller.on("toast", (message) => {
    if (!window.isDestroyed()) window.webContents.send("app.toast", message);
  });
  controller.on("input", (state) => {
    if (!window.isDestroyed()) window.webContents.send("input.state", state);
    uiEvents.emit("changed");
  });
  window.webContents.on("context-menu", () => {
    createClockMenu()?.popup({ window });
  });
  window.webContents.on("before-input-event", () => {
    // Menu accelerators must not consume capture input or dispatch twice.
    window.webContents.setIgnoreMenuShortcuts(!!controlSettings?.opened);
  });
  window.on("focus", () => syncControlBlock());
  window.on("blur", () => syncControlBlock());
  const rendererUnavailable = () => {
    rendererReady = false;
    syncControlBlock();
    controlRouter.reset();
    controlSettings.abandon();
    controlHost.destroy();
    window.webContents.setIgnoreMenuShortcuts(false);
    publishInputEpoch();
    updateMenu();
  };
  window.webContents.on("render-process-gone", rendererUnavailable);
  window.webContents.on("did-start-loading", rendererUnavailable);
  window.webContents.on("did-finish-load", () => {
    rendererReady = true;
    syncControlBlock();
    publishInputEpoch();
    restorePreferredClock();
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
    !!controlSettings?.opened ||
    nativeDialog ||
    windowMode?.state.clockMode ||
    windowMode?.transitioning ||
    ["starting", "stopping"].includes(controller.state.status) ||
    !!controller.state.stateOperation ||
    !!controller.state.deviceOperation;
  const menu = Menu.getApplicationMenu();
  for (const value of deviceMenuItems(deviceMenuActions())) {
    if (!value.id) continue;
    const item = menu?.getMenuItemById(value.id);
    if (item) {
      item.enabled = value.enabled ?? false;
      if (value.type === "checkbox") item.checked = value.checked ?? false;
    }
  }
  for (const id of ["controls.open", "controls.hotkeys"]) {
    const item = menu?.getMenuItemById(id);
    if (item)
      item.enabled =
        !makerOpen &&
        !nativeDialog &&
        !active &&
        !shuttingDown &&
        !controlSettings?.opened;
  }
  if (menu)
    for (const id of ["file.open", "file.make"]) {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = !blocked;
    }
  const statesEnabled =
    !blocked &&
    controller.state.status === "running" &&
    controller.state.canInstantState !== false;
  for (const id of ["state.save", "state.load"]) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = statesEnabled;
  }
  for (let slot = 0; slot < 10; slot++) {
    const item = menu?.getMenuItemById(`state.slot.${slot}`);
    if (!item) continue;
    item.enabled = statesEnabled;
    const savedAt = controller.state.stateSlots?.[slot];
    item.label = `${t("state.slot", { slot })} · ${savedAt ? new Date(savedAt).toLocaleString() : t("state.emptyLabel")}`;
    if ((controller.state.stateSlot ?? 0) === slot) item.checked = true;
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
      !makerOpen &&
      !controlSettings?.opened &&
      !nativeDialog &&
      !active &&
      !windowMode.transitioning;
  }
  const mute = menu?.getMenuItemById("audio.mute");
  if (mute) {
    mute.checked = !audioPreference.enabled;
    mute.enabled =
      !shuttingDown &&
      !makerOpen &&
      !controlSettings?.opened &&
      !nativeDialog &&
      !active &&
      !windowMode.transitioning &&
      !["starting", "stopping"].includes(controller.state.status);
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
      !controlSettings?.opened &&
      !nativeDialog &&
      !active &&
      !windowMode.transitioning &&
      controller.state.status === "running";
  }
}
/** Queue toggles against the last committed preference; rollback native checks on failure. */
function toggleChassis() {
  if (controlSettings?.opened)
    return Promise.reject(new UserError("error.busy"));
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
    !controlSettings?.opened &&
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
    !controlSettings?.opened &&
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
  await perform(async () => {
    await windowMode.setScale(factor);
    await viewSettings.flush();
  });
  logger
    .child("view")
    .info(
      { event: "window.scale", ...windowMode.state },
      "Pixel scale changed",
    );
}
async function toggleClock() {
  if (makerOpen || controlSettings?.opened || nativeDialog || shuttingDown)
    throw new UserError("error.busy");
  if (!windowMode.state.clockMode && controller.state.status !== "running")
    throw new UserError("error.busy");
  try {
    await perform(async () => {
      await windowMode.toggle();
      await viewSettings.flush();
    });
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
function stateMenuActions() {
  return {
    stateSlot: controller.state.stateSlot ?? 0,
    stateSlots: controller.state.stateSlots,
    canState:
      controller.state.status === "running" &&
      controller.state.canInstantState !== false &&
      !controller.state.stateOperation &&
      !controller.state.deviceOperation &&
      !shuttingDown &&
      !makerOpen &&
      !controlSettings.opened &&
      !nativeDialog,
    controlAccelerators: controlAccelerators(controlSettings.config),
    saveState: () => {
      void runControlAction("state.save").catch(showError);
    },
    loadState: () => {
      void runControlAction("state.load").catch(showError);
    },
    selectStateSlot: (slot: number) => controller.selectStateSlot(slot),
  };
}
function deviceMenuActions() {
  return {
    deviceSupported: paths.kernel === "gwemu",
    deviceState: controller.state,
    canDevice:
      !shuttingDown &&
      !makerOpen &&
      !controlSettings?.opened &&
      !nativeDialog &&
      !active &&
      !windowMode.transitioning,
    deviceAction: (id: Parameters<SessionController["deviceAction"]>[0]) => {
      observedActivity = runControlAction(id);
      void observedActivity.catch(showError);
    },
  };
}
function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(process.platform, {
        ...stateMenuActions(),
        ...deviceMenuActions(),
        openHotkeys: () => {
          void openControlSettings("hotkeys").catch(showError);
        },
        openControls: () => {
          void openControlSettings().catch(showError);
        },
        controlAccelerators: controlSettings
          ? controlAccelerators(controlSettings.config)
          : undefined,
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
        muted: !audioPreference.enabled,
        toggleMute: () => {
          void toggleMute().catch(showError);
        },
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
function canClockInteract() {
  return (
    windowMode.state.clockMode &&
    !shuttingDown &&
    !controlSettings?.opened &&
    !makerOpen &&
    !nativeDialog &&
    !active &&
    !windowMode.transitioning &&
    controller.state.status === "running"
  );
}
function createClockMenu() {
  if (!windowMode.state.clockMode) return undefined;
  return Menu.buildFromTemplate(
    clockMenuTemplate({
      ...stateMenuActions(),
      ...deviceMenuActions(),
      normal: () => {
        void toggleClock().catch(showError);
      },
      clockDock: windowMode.state.clockDock,
      canInteract: canClockInteract(),
      dock: (corner) => {
        void setDock(corner).catch(showError);
      },
      showChassis: preferences.showChassis,
      toggleChassis: () => {
        void toggleChassis().catch(showError);
      },
      muted: !audioPreference.enabled,
      toggleMute: () => {
        void toggleMute().catch(showError);
      },
      pixelScale: windowMode.state.pixelScale,
      canScale: (factor) => canSetScale(factor),
      setScale: (factor) => {
        void setScale(factor).catch(showError);
      },
      quit: () => {
        void shutdown();
      },
    }),
  );
}
async function setDock(corner: DockCorner) {
  if (!canClockInteract()) throw new UserError("error.busy");
  await perform(async () => {
    windowMode.setDock(corner);
    await viewSettings.flush();
  });
  logger
    .child("view")
    .info(
      { event: "window.dock", corner, bounds: window.getBounds() },
      "Clock dock changed",
    );
}
async function toggleMute() {
  if (
    makerOpen ||
    controlSettings?.opened ||
    nativeDialog ||
    shuttingDown ||
    windowMode.transitioning ||
    ["starting", "stopping"].includes(controller.state.status)
  )
    throw new UserError("error.busy");
  await perform(() => audioPreference.toggle());
  logger.child("audio").info(
    {
      event: "audio.mute",
      muted: !audioPreference.enabled,
      runtimeSessionId: controller.state.runtimeSessionId,
    },
    "Audio mute changed",
  );
  uiEvents.emit("changed");
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
  syncControlBlock();
  controller.releaseInput();
  updateMenu();
  try {
    return await work();
  } finally {
    nativeDialog = false;
    updateMenu();
    window.webContents.focus();
    syncControlBlock();
  }
}
async function openRom() {
  if (makerOpen) throw new UserError("error.makerOpen");
  if (controlSettings?.opened) throw new UserError("error.busy");
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
    controlSettings?.opened ||
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
  if (
    makerOpen ||
    controlSettings.opened ||
    nativeDialog ||
    active ||
    windowMode.state.clockMode
  )
    return;
  controller.releaseInput();
  makerOpen = true;
  syncControlBlock();
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
function trusted(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  scope: "game" | "shared" | "controls" = "game",
) {
  const hosts =
    scope === "game"
      ? [window]
      : scope === "controls"
        ? [controlHost?.window]
        : [window, controlHost?.window];
  if (
    !hosts.some(
      (host) =>
        host &&
        !host.isDestroyed() &&
        event.sender === host.webContents &&
        event.senderFrame === host.webContents.mainFrame,
    )
  )
    throw new Error("Unauthorized renderer");
}
function registerIpc() {
  ipcMain.handle("controls.window", (event) => {
    trusted(event, "shared");
    return controlHost.window
      ? {
          page: controlHost.page!,
          model: controller.state.model ?? lastControlModel,
          config: controlSettings.config,
          epoch: controlRouter.epoch,
          participation: controlParticipation,
        }
      : null;
  });
  ipcMain.handle("controls.get", (event) => {
    trusted(event, "shared");
    return controlSettings.config;
  });
  ipcMain.handle("input.epoch", (event) => {
    trusted(event, "shared");
    return controlRouter.epoch;
  });
  ipcMain.handle("controls.open", (event, page = "buttons") => {
    trusted(event);
    if (page !== "buttons" && page !== "hotkeys")
      throw Error("Invalid controls page");
    return openControlSettings(page);
  });
  ipcMain.handle("controls.save", async (event, config, participation = []) => {
    trusted(event, "controls");
    const devices = gamepadParticipationSchema.parse(participation);
    await perform(() => controlSettings.save(controlsSchema.parse(config)));
    controlParticipation = devices;
    window.webContents.send("controls.participation", devices);
    closeControlSettings();
  });
  ipcMain.handle("controls.close", (event) => {
    trusted(event, "controls");
    closeControlSettings();
  });
  ipcMain.on("controls.devices", (event, value) => {
    trusted(event);
    const parsed = gamepadParticipationSchema.safeParse(value);
    if (parsed.success && !controlSettings.opened)
      controlParticipation = parsed.data;
  });
  ipcMain.on("controls.input", (event, value) => {
    trusted(event, "shared");
    const parsed = controlInputSchema.safeParse(value);
    if (!parsed.success) return;
    syncControlBlock();
    controlRouter.event(parsed.data);
  });
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
    trusted(event, "shared");
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
      controlRouter.event({
        source: "legacy-keyboard",
        input: { kind: "keyboard", code },
        down,
        modifiers: [],
        epoch: controlRouter.epoch,
      });
  });
  ipcMain.on("input.release", (event) => {
    trusted(event);
    controlRouter.reset();
    publishInputEpoch();
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
          !controlSettings.opened &&
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
    if (controlSettings.opened) return;
    if (typeof open === "boolean") {
      makerOpen = open;
      windowMode.setModal(open);
      if (!open) restorePreferredClock();
      controller.releaseInput();
      syncControlBlock();
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
    trusted(event, "shared");
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
  const ui = new UiDriver(window, createClockMenu, () => controlHost?.window);
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
    case "ui.menu":
    case "ui.contextMenu": {
      observedActivity = undefined;
      const result = await ui.menu(params.id, method === "ui.contextMenu");
      if (observedActivity) await observedActivity;
      return result;
    }
    case "ui.screenshot":
      return ui.screenshot(params.path);
    case "app.getState":
      return stateForUi(controller.state);
    case "app.getDiagnostics":
      return {
        controls: {
          isolated: controlSettings.opened,
          epoch: controlRouter.epoch,
          bindingCount: controlSettings.config.bindings.length,
        },
        ...controller.diagnostics(),
        audio: {
          enabled: audioPreference.enabled,
          muted: !audioPreference.enabled,
        },
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
  controlHost?.destroy();
  controlRouter?.dispose();
  try {
    await managerService?.close();
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
    await managerService?.close().catch(() => {});
    await controller.stop().catch(() => {});
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
    .catch(async (error) => {
      await managerService?.close().catch(() => {});
      await controller?.stop().catch(() => {});
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
