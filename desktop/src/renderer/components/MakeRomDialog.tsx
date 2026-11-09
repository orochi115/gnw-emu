import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProfileFields } from "../../core/schemas";
const labels: Record<string, string> = {
  internalFlash: "内部 Flash",
  externalFlash: "外部 Flash",
  bank2Flash: "Bank 2",
  sdCard: "SD 卡镜像",
  deviceUid: "器件 UID",
};
export function MakeRomDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const focusTarget = useRef<string | null>(null);
  const [fields, setFields] = useState<ProfileFields>({
    model: "zelda",
    internalFlash: "",
    externalFlash: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    if (busy || !focusTarget.current) return;
    const element = document.getElementById(focusTarget.current);
    const details = element?.closest("details");
    if (details) details.open = true;
    element?.focus();
    focusTarget.current = null;
  }, [busy, invalid]);
  const ready =
    !!fields.internalFlash.trim() && !!fields.externalFlash.trim() && !busy;
  useEffect(() => {
    dialog.current!.showModal();
    window.desktop.modal(true);
    return () => window.desktop.modal(false);
  }, []);
  const update = (key: string, value: string) => {
    setFields((old) => ({ ...old, [key]: value }));
    setInvalid((old) => ({ ...old, [key]: "" }));
    setError("");
  };
  const save = async (load: boolean) => {
    setBusy(true);
    setError("");
    try {
      const clean = Object.fromEntries(
        Object.entries(fields).filter(([_key, value]) => value !== ""),
      ) as unknown as ProfileFields;
      if (!clean.sdCard) delete clean.sdWiring;
      const result = await window.desktop.saveRom(clean, load);
      if (result.saved) close();
    } catch (e) {
      const message = (e as Error).message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      );
      setError(message);
      const key = Object.keys(labels).find(
        (k) => message.includes(k) || message.includes(labels[k]),
      );
      if (key) {
        setInvalid((v) => ({ ...v, [key]: message }));
        focusTarget.current = key === "deviceUid" ? "uid" : `field-${key}`;
      }
    } finally {
      setBusy(false);
    }
  };
  const file = (key: keyof ProfileFields, required = false) => (
    <div className="field" key={key}>
      <label htmlFor={`field-${key}`}>
        {labels[key]}
        {!required && <span className="optional">可选</span>}
      </label>
      <div className="file-input">
        <input
          id={`field-${key}`}
          data-ui={`rom.${key}`}
          value={fields[key] ?? ""}
          title={fields[key] ?? ""}
          placeholder="选择镜像文件"
          spellCheck={false}
          disabled={busy}
          aria-invalid={!!invalid[key]}
          aria-describedby={invalid[key] ? `error-${key}` : undefined}
          onChange={(e) => update(key, e.target.value)}
          onBlur={() => {
            if (required && !String(fields[key]).trim())
              setInvalid((v) => ({ ...v, [key]: "请选择镜像文件" }));
          }}
        />
        <button
          type="button"
          aria-label={`浏览${labels[key]}`}
          data-ui={`rom.browse.${key}`}
          disabled={busy}
          onClick={async () => {
            try {
              const path = await window.desktop.pickImage(key);
              if (path) update(key, path);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          浏览…
        </button>
      </div>
      {invalid[key] && (
        <p className="field-error" id={`error-${key}`}>
          {invalid[key]}
        </p>
      )}
    </div>
  );
  return (
    <dialog
      ref={dialog}
      className="maker"
      aria-labelledby="maker-title"
      data-ui="rom.dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
    >
      <header className="dialog-header">
        <h1 id="maker-title">制作 ROM</h1>
        <p>组合已有镜像，保存为可直接加载的 ROM 配置。</p>
      </header>
      <div className="dialog-body">
        <section>
          <div className="field">
            <label htmlFor="model">机型</label>
            <select
              id="model"
              data-ui="rom.model"
              value={fields.model}
              disabled={busy}
              onChange={(e) => update("model", e.target.value)}
            >
              <option value="zelda">Game & Watch · Zelda</option>
              <option value="mario">Game & Watch · Mario</option>
            </select>
          </div>
          {file("internalFlash", true)}
          {file("externalFlash", true)}
        </section>
        <section className="optional-section">
          <h2>可选镜像</h2>
          {file("bank2Flash")}
          {file("sdCard")}
          {fields.sdCard && (
            <div className="field">
              <label htmlFor="sd-wiring">SD 接线</label>
              <select
                id="sd-wiring"
                data-ui="rom.sdWiring"
                value={fields.sdWiring ?? "spi1"}
                disabled={busy}
                onChange={(e) => update("sdWiring", e.target.value)}
              >
                <option value="spi1">SPI1</option>
                <option value="ospi">OSPI</option>
              </select>
            </div>
          )}
        </section>
        <details>
          <summary>高级选项</summary>
          <div className="field">
            <label htmlFor="uid">
              器件 UID<span className="optional">可选</span>
            </label>
            <input
              id="uid"
              aria-invalid={!!invalid.deviceUid}
              aria-describedby={
                invalid.deviceUid ? "error-deviceUid" : undefined
              }
              data-ui="rom.deviceUid"
              value={fields.deviceUid ?? ""}
              placeholder="24 位十六进制，留空使用默认值"
              disabled={busy}
              onChange={(e) => update("deviceUid", e.target.value)}
            />
            <p className="hint">仅用于需要特定设备身份的固件。</p>
            {invalid.deviceUid && (
              <p id="error-deviceUid" className="field-error">
                {invalid.deviceUid}
              </p>
            )}
          </div>
        </details>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <button
          type="button"
          data-ui="rom.cancel"
          disabled={busy}
          onClick={close}
        >
          取消
        </button>
        <div className="save-actions">
          <button
            type="button"
            data-ui="rom.save"
            disabled={!ready}
            onClick={() => save(false)}
          >
            保存…
          </button>
          <button
            type="button"
            className="primary"
            data-ui="rom.saveAndLoad"
            disabled={!ready}
            onClick={() => save(true)}
          >
            {busy ? "正在保存…" : "保存并加载…"}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
