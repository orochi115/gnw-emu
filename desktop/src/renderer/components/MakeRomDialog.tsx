import { t, fieldLabel } from "../../shared/locale";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProfileFields } from "../../core/schemas";
export function MakeRomDialog({ close }: { close: () => void }) {
  const labels = Object.fromEntries(
    ["internalFlash", "externalFlash", "bank2Flash", "sdCard"].map((key) => [
      key,
      fieldLabel(key),
    ]),
  );
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
        focusTarget.current = `field-${key}`;
      }
    } finally {
      setBusy(false);
    }
  };
  const file = (key: keyof ProfileFields, required = false) => (
    <div className="field" key={key}>
      <label htmlFor={`field-${key}`}>
        {labels[key]}
        {!required && <span className="optional">{t("rom.optional")}</span>}
      </label>
      <div className="file-input">
        <input
          id={`field-${key}`}
          data-ui={`rom.${key}`}
          value={fields[key] ?? ""}
          title={fields[key] ?? ""}
          placeholder={t("rom.chooseImage")}
          spellCheck={false}
          disabled={busy}
          aria-invalid={!!invalid[key]}
          aria-describedby={invalid[key] ? `error-${key}` : undefined}
          onChange={(e) => update(key, e.target.value)}
          onBlur={() => {
            if (required && !String(fields[key]).trim())
              setInvalid((v) => ({ ...v, [key]: t("rom.chooseImage") }));
          }}
        />
        <button
          type="button"
          aria-label={t("rom.browseField", { field: labels[key] })}
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
          {t("rom.browse")}
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
        <h1 id="maker-title">{t("rom.title")}</h1>
        <p>{t("rom.description")}</p>
      </header>
      <div className="dialog-body">
        <section>
          <div className="field">
            <span id="model-label" className="field-label">
              {t("rom.model")}
            </span>
            <div
              className="model-selector"
              role="radiogroup"
              aria-labelledby="model-label"
              data-ui="rom.model"
            >
              {(["zelda", "mario"] as const).map((model) => (
                <label className="model-option" key={model}>
                  <input
                    type="radio"
                    name="model"
                    value={model}
                    data-ui={`rom.model.${model}`}
                    checked={fields.model === model}
                    disabled={busy}
                    onChange={() => update("model", model)}
                  />
                  <span>{model === "zelda" ? "Zelda" : "Mario"}</span>
                </label>
              ))}
            </div>
          </div>
          {file("internalFlash", true)}
          {file("externalFlash", true)}
        </section>
        <section className="optional-section">
          <h2>{t("rom.optionalImages")}</h2>
          {file("bank2Flash")}
          {file("sdCard")}
          {
            <div className="field">
              <label htmlFor="sd-wiring">{t("rom.sdWiring")}</label>
              <select
                id="sd-wiring"
                data-ui="rom.sdWiring"
                value={fields.sdWiring ?? "spi1"}
                disabled={busy || !fields.sdCard?.trim()}
                aria-describedby={
                  !fields.sdCard?.trim() ? "sd-wiring-hint" : undefined
                }
                onChange={(e) => update("sdWiring", e.target.value)}
              >
                <option value="spi1">{t("rom.spi1")}</option>
                <option value="ospi">{t("rom.ospi")}</option>
              </select>
              {!fields.sdCard?.trim() && (
                <p id="sd-wiring-hint" className="hint">
                  {t("rom.wiringHint")}
                </p>
              )}
            </div>
          }
        </section>
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
          {t("rom.cancel")}
        </button>
        <div className="save-actions">
          <button
            type="button"
            data-ui="rom.save"
            disabled={!ready}
            onClick={() => save(false)}
          >
            {t("rom.save")}
          </button>
          <button
            type="button"
            className="primary"
            data-ui="rom.saveAndLoad"
            disabled={!ready}
            onClick={() => save(true)}
          >
            {t(busy ? "rom.saving" : "rom.saveAndLoad")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
