import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../shared/locale";
import {
  bindingIdentity,
  controlsSchema,
  defaultControls,
  findConflicts,
  HOTKEY_ACTIONS,
  isHotkeyTarget,
  type ControlBinding,
  type ControlsSettings,
} from "../../../shared/controls";
import { BindingRow } from "./BindingIcons";
import {
  BindingDetails,
  turboLabel,
  turboOptions,
  type InputSubscription,
} from "./BindingDetails";
import { ControlsDiagram } from "./ControlsDiagram";
import "./controls.css";
import { normalizeControlsDraft } from "./presentation";
import { DeviceParticipationDraft } from "./device-participation";
export interface ControlsDevice {
  instance: string;
  fingerprint: string;
  name: string;
  enabled: boolean;
  collision?: boolean;
  standard?: boolean;
}
export interface ControlsDialogProps {
  initial: ControlsSettings;
  model?: "mario" | "zelda";
  page?: "buttons" | "hotkeys";
  embedded?: boolean;
  devices?: ControlsDevice[];
  deviceError?: string;
  subscribeInput?: InputSubscription;
  setDeviceParticipation?: (instance: string, enabled: boolean) => void;
  save: (settings: ControlsSettings) => Promise<void>;
  close: () => void | Promise<void>;
}
export function ControlsDialog({
  initial,
  model = "zelda",
  page = "buttons",
  embedded = false,
  devices = [],
  deviceError,
  subscribeInput,
  setDeviceParticipation,
  save,
  close,
}: ControlsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const participationDraft = useRef(new DeviceParticipationDraft());
  const [draft, setDraft] = useState(() => normalizeControlsDraft(initial));
  const Container = embedded ? "section" : "dialog";
  const [detail, setDetail] = useState<{
    target: string;
    id?: string;
    key: number;
  } | null>(null);
  const [devicePanel, setDevicePanel] = useState(false);
  const [menu, setMenu] = useState<{
    binding: ControlBinding;
    x: number;
    y: number;
    turbo: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [directionAxes, setDirectionAxes] = useState<
    Record<string, { horizontal: number; vertical: number }>
  >({});
  const [runtimeParticipation, setRuntimeParticipation] = useState<
    Record<string, boolean>
  >({});
  const conflicts = useMemo(() => findConflicts(draft), [draft]);
  const conflictIds = useMemo(
    () => new Set(Object.keys(conflicts)),
    [conflicts],
  );
  useEffect(() => {
    if (!embedded) dialog.current?.showModal();
  }, [embedded]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".controls-context-menu")
      )
        setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  const edit = (target: string, binding?: ControlBinding) => {
    setMenu(null);
    setDetail({ target, id: binding?.id, key: Date.now() });
  };
  const remove = (id: string) => {
    setDraft((old) => ({
      ...old,
      bindings: old.bindings.filter((binding) => binding.id !== id),
    }));
    setMenu(null);
  };
  const update = (binding: ControlBinding) => {
    const normalized = { ...binding, modifiers: [...binding.modifiers].sort() };
    if (
      !controlsSchema.safeParse({
        ...draft,
        bindings: [
          ...draft.bindings.filter((item) => item.id !== binding.id),
          normalized,
        ],
      }).success
    )
      return false;
    if (
      draft.bindings.some(
        (item) =>
          item.id !== binding.id &&
          bindingIdentity(item) === bindingIdentity(normalized),
      )
    )
      return false;
    setDraft((old) => ({
      ...old,
      bindings: old.bindings.some((item) => item.id === binding.id)
        ? old.bindings.map((item) =>
            item.id === binding.id ? normalized : item,
          )
        : [...old.bindings, normalized],
    }));
    setDetail((old) => (old ? { ...old, id: binding.id } : old));
    setError("");
    return true;
  };
  const openMenu = (
    binding: ControlBinding,
    position: { x: number; y: number },
  ) =>
    setMenu({
      binding,
      x: Math.min(position.x, window.innerWidth - 390),
      y: Math.min(position.y, window.innerHeight - 235),
      turbo: false,
    });
  const participate = (device: ControlsDevice, enabled: boolean) => {
    participationDraft.current.change(device, enabled, setDeviceParticipation);
    setRuntimeParticipation((old) => ({ ...old, [device.instance]: enabled }));
    if (!device.collision)
      setDraft((old) => ({
        ...old,
        devices: {
          ...old.devices,
          [device.fingerprint]: {
            enabled,
            deadzone: old.devices[device.fingerprint]?.deadzone ?? 0.2,
          },
        },
      }));
  };
  const groupDirections = (device: ControlsDevice) => {
    const additions: ControlBinding[] = [];
    const axes = directionAxes[device.fingerprint] ?? {
      horizontal: 0,
      vertical: 1,
    };
    for (const [target, index, direction] of [
      ["left", axes.horizontal, -1],
      ["right", axes.horizontal, 1],
      ["up", axes.vertical, -1],
      ["down", axes.vertical, 1],
    ] as const) {
      additions.push({
        id: crypto.randomUUID(),
        target,
        inputs: [
          {
            kind: "gamepad",
            device: device.fingerprint,
            control: "axis",
            index,
            direction,
          },
        ],
        modifiers: [],
        turbo: null,
      });
    }
    if (device.standard)
      for (const [target, index] of [
        ["up", 12],
        ["down", 13],
        ["left", 14],
        ["right", 15],
      ] as const)
        additions.push({
          id: crypto.randomUUID(),
          target,
          inputs: [
            {
              kind: "gamepad",
              device: device.fingerprint,
              control: "button",
              index,
            },
          ],
          modifiers: [],
          turbo: null,
        });
    setDraft((old) => ({
      ...old,
      bindings: [
        ...old.bindings,
        ...additions.filter(
          (binding) =>
            !old.bindings.some(
              (item) => bindingIdentity(item) === bindingIdentity(binding),
            ),
        ),
      ],
    }));
    setDevicePanel(false);
  };
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await close();
      participationDraft.current.cancel(devices, setDeviceParticipation);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!embedded) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !detail && !menu && !devicePanel) {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [embedded, detail, menu, devicePanel, busy]);
  const commit = async () => {
    setBusy(true);
    setError("");
    try {
      await save(controlsSchema.parse(draft));
    } catch (cause) {
      setError(
        (cause as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
      setBusy(false);
    }
  };
  const selectedBinding = detail
    ? draft.bindings.find((binding) => binding.id === detail.id)
    : undefined;
  return (
    <Container
      ref={(element) => {
        dialog.current = element instanceof HTMLDialogElement ? element : null;
      }}
      className={`controls-dialog ${embedded ? "controls-embedded" : ""} controls-${page}`}
      aria-labelledby="controls-title"
      data-ui="controls.dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!detail && !menu) void cancel();
      }}
    >
      <header className="controls-header">
        <h1 id="controls-title">{t(`controls.${page}`)}</h1>
        <div className="controls-header-actions">
          <button
            className="controls-device-toggle"
            aria-expanded={devicePanel}
            data-ui="controls.devices"
            onClick={() => setDevicePanel(!devicePanel)}
          >
            {t("controls.devices")} · {devices.length}
          </button>
          <button
            className="controls-close"
            aria-label={t("controls.cancel")}
            disabled={busy}
            onClick={() => void cancel()}
          >
            ×
          </button>
        </div>
      </header>
      <div className="controls-body">
        {page === "buttons" ? (
          <ControlsDiagram
            model={model}
            bindings={draft.bindings}
            conflictIds={conflictIds}
            edit={edit}
            remove={remove}
            menu={openMenu}
          />
        ) : (
          <div className="controls-hotkey-scroll">
            <table className="controls-hotkey-table">
              <thead>
                <tr>
                  <th>{t("controls.action")}</th>
                  <th>{t("controls.bindings")}</th>
                </tr>
              </thead>
              <tbody>
                {HOTKEY_ACTIONS.map((action) => (
                  <tr key={action.id} data-ui={`controls.action.${action.id}`}>
                    <th scope="row">{t(`controls.action.${action.id}`)}</th>
                    <td>
                      <BindingRow
                        hotkey
                        bindings={draft.bindings.filter(
                          (binding) => binding.target === action.id,
                        )}
                        target={action.id}
                        conflictIds={conflictIds}
                        edit={edit}
                        remove={remove}
                        menu={openMenu}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {devicePanel && (
          <section
            className="controls-device-panel"
            aria-labelledby="controls-device-title"
          >
            <header>
              <h2 id="controls-device-title">{t("controls.devices")}</h2>
              <button
                aria-label={t("controls.done")}
                onClick={() => setDevicePanel(false)}
              >
                ×
              </button>
            </header>
            <p>
              {t("controls.keyboard")} · {t("controls.connected")}
            </p>
            {deviceError ? (
              <p role="status" className="controls-warning">
                {t("controls.gamepadUnavailable")} {deviceError}
              </p>
            ) : (
              devices.length === 0 && (
                <p className="controls-muted">{t("controls.noGamepad")}</p>
              )
            )}
            {devices.map((device) => (
              <article key={device.instance}>
                <label>
                  <input
                    type="checkbox"
                    checked={
                      runtimeParticipation[device.instance] ??
                      (device.collision
                        ? device.enabled
                        : (draft.devices[device.fingerprint]?.enabled ??
                          device.enabled))
                    }
                    onChange={(event) =>
                      participate(device, event.target.checked)
                    }
                  />
                  <span>
                    {device.name}
                    <small>
                      {device.collision
                        ? t("controls.thisConnection")
                        : t("controls.connected")}{" "}
                      · {device.instance}
                    </small>
                  </span>
                </label>
                <div className="controls-direction-settings">
                  <label>
                    {t("controls.deadzone")}
                    <input
                      type="range"
                      min="5"
                      max="60"
                      step="5"
                      value={Math.round(
                        (draft.devices[device.fingerprint]?.deadzone ?? 0.2) *
                          100,
                      )}
                      onChange={(event) =>
                        setDraft((old) => ({
                          ...old,
                          devices: {
                            ...old.devices,
                            [device.fingerprint]: {
                              enabled:
                                old.devices[device.fingerprint]?.enabled ??
                                true,
                              deadzone: Number(event.target.value) / 100,
                            },
                          },
                        }))
                      }
                    />
                    <output>
                      {Math.round(
                        (draft.devices[device.fingerprint]?.deadzone ?? 0.2) *
                          100,
                      )}
                      %
                    </output>
                  </label>
                  {!device.standard && (
                    <div className="controls-axis-fields">
                      {(["horizontal", "vertical"] as const).map((axis) => (
                        <label key={axis}>
                          {t(`controls.axis.${axis}`)}
                          <input
                            type="number"
                            min="0"
                            max="15"
                            value={
                              (directionAxes[device.fingerprint] ?? {
                                horizontal: 0,
                                vertical: 1,
                              })[axis]
                            }
                            onChange={(event) =>
                              setDirectionAxes((old) => ({
                                ...old,
                                [device.fingerprint]: {
                                  ...(old[device.fingerprint] ?? {
                                    horizontal: 0,
                                    vertical: 1,
                                  }),
                                  [axis]: Math.max(
                                    0,
                                    Math.min(
                                      15,
                                      Math.floor(
                                        Number(event.target.value) || 0,
                                      ),
                                    ),
                                  ),
                                },
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <button onClick={() => groupDirections(device)}>
                    {t("controls.addDirections")}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
      {error && (
        <p className="controls-save-error" role="alert">
          {error}
        </p>
      )}
      <footer className="controls-footer">
        <button
          className="controls-restore"
          disabled={busy}
          data-ui="controls.restore"
          onClick={() => {
            setDraft(
              defaultControls(
                navigator.platform.includes("Mac") ? "darwin" : "",
              ),
            );
            for (const device of devices)
              participationDraft.current.change(
                device,
                true,
                setDeviceParticipation,
              );
            setRuntimeParticipation({});
            setError("");
          }}
        >
          {t("controls.restore")}
        </button>
        <span className="controls-muted">
          {Object.keys(conflicts).length > 0
            ? t("controls.conflictCount", {
                count: Object.keys(conflicts).length,
              })
            : ""}
        </span>
        <div>
          <button
            disabled={busy}
            data-ui="controls.cancel"
            onClick={() => void cancel()}
          >
            {t("controls.cancel")}
          </button>
          <button
            className="controls-primary"
            disabled={busy}
            data-ui="controls.save"
            onClick={() => void commit()}
          >
            {t(busy ? "controls.saving" : "controls.save")}
          </button>
        </div>
      </footer>
      {menu && (
        <div
          className="controls-context-menu"
          role="menu"
          style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                  buttons.length
              ]?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            autoFocus
            onClick={() => edit(menu.binding.target, menu.binding)}
          >
            {t("controls.edit")}
          </button>
          {!isHotkeyTarget(menu.binding.target) && (
            <>
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={menu.turbo}
                onMouseEnter={() => setMenu({ ...menu, turbo: true })}
                onClick={() => setMenu({ ...menu, turbo: !menu.turbo })}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight")
                    setMenu({ ...menu, turbo: true });
                }}
              >
                {t("controls.turbo")}　›
              </button>
              {menu.turbo && (
                <div className="controls-turbo-submenu" role="menu">
                  {turboOptions.map((value) => (
                    <button
                      role="menuitemradio"
                      aria-checked={menu.binding.turbo === value}
                      key={String(value)}
                      onClick={() => {
                        update({ ...menu.binding, turbo: value });
                        setMenu(null);
                      }}
                    >
                      {turboLabel(value, draft.defaultTurboHz)}
                      <span>{menu.binding.turbo === value ? "✓" : ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button
            role="menuitem"
            className="controls-danger"
            onClick={() => remove(menu.binding.id)}
          >
            {t("controls.delete")}
          </button>
        </div>
      )}
      {detail && (
        <BindingDetails
          key={detail.key}
          target={detail.target}
          binding={selectedBinding}
          hotkey={isHotkeyTarget(detail.target)}
          defaultHz={draft.defaultTurboHz}
          conflictBindings={(conflicts[detail.id ?? ""] ?? []).flatMap(
            (conflict) =>
              draft.bindings.filter(
                (binding) => binding.id === conflict.bindingId,
              ),
          )}
          subscribeInput={subscribeInput}
          selectCaptureSource={(source) => {
            const instance = source.split(":")[1];
            const selected = devices.find(
              (device) => device.instance === instance,
            );
            if (selected?.collision)
              for (const device of devices)
                if (device.fingerprint === selected.fingerprint)
                  participate(device, device.instance === instance);
          }}
          update={update}
          remove={remove}
          close={() => setDetail(null)}
        />
      )}
    </Container>
  );
}
