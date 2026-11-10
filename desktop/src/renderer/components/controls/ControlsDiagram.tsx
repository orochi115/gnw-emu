import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../shared/locale";
import type { ControlBinding } from "../../../shared/controls";
import mario from "../../assets/controls/mario-original.png";
import zelda from "../../assets/controls/zelda-original.png";
import { BindingRow } from "./BindingIcons";
const positions: Record<string, [number, number]> = {
  up: [24, 195],
  left: [24, 305],
  down: [24, 415],
  right: [24, 525],
  game: [1016, 30],
  time: [1016, 140],
  pause: [1016, 250],
  power: [1016, 360],
  start: [1016, 500],
  select: [300, 610],
  b: [570, 610],
  a: [840, 610],
};
const sharedLines = {
  up: "M377 410 V365 H270 V241 H244",
  left: "M348 438 H258 V351 H244",
  down: "M377 468 V515 H270 V461 H244",
  right: "M407 438 V571 H244",
  power: "M920 380 H992 V406 H1016",
};
const lines: Record<string, Record<string, string>> = {
  zelda: {
    ...sharedLines,
    game: "M816 221 V150 H992 V76 H1016",
    time: "M816 264 H944 V186 H1016",
    pause: "M816 306 H968 V296 H1016",
    select: "M808 410 H750 V575 H410 V610",
    start: "M875 410 H952 V546 H1016",
    b: "M808 462 V590 H680 V610",
    a: "M875 462 V590 H950 V610",
  },
  mario: {
    ...sharedLines,
    game: "M825 221 V150 H992 V76 H1016",
    time: "M825 264 H944 V186 H1016",
    pause: "M825 306 H968 V296 H1016",
    b: "M808 438 V590 H680 V610",
    a: "M875 438 V590 H950 V610",
  },
};
export function ControlsDiagram({
  model,
  bindings,
  conflictIds,
  edit,
  remove,
  menu,
}: {
  model: "mario" | "zelda";
  bindings: ControlBinding[];
  conflictIds: Set<string>;
  edit: (target: string, binding?: ControlBinding) => void;
  remove: (id: string) => void;
  menu: (binding: ControlBinding, position: { x: number; y: number }) => void;
}) {
  const [highlight, setHighlight] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const resize = () =>
      setScale(
        Math.max(
          0.75,
          Math.min(1, element.clientWidth / 1260, element.clientHeight / 740),
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="controls-stage-scroll" ref={viewport}>
      <div
        className="controls-stage"
        style={{ zoom: scale }}
        data-ui={`controls.diagram.${model}`}
      >
        <p className="controls-stage-note">
          {t("controls.diagramHint")}
          <br />
          <span>⚡ {t("controls.turbo")}</span>
        </p>
        <img
          className="controls-hardware"
          src={model === "mario" ? mario : zelda}
          alt={t("chassis.device", {
            model: model === "mario" ? "Mario" : "Zelda",
          })}
        />
        <svg
          className="controls-leaders"
          viewBox="0 0 1260 740"
          aria-hidden="true"
        >
          {Object.entries(lines[model]).map(([target, path]) => {
            const start = path.match(/^M(\d+) (\d+)/)!;
            return (
              <g
                key={target}
                className={highlight === target ? "highlight" : ""}
              >
                <path className="halo" d={path} />
                <path className="ink" d={path} />
                <circle cx={start[1]} cy={start[2]} r="4" />
              </g>
            );
          })}
        </svg>
        {Object.entries(positions).map(([target, [x, y]]) => {
          const own = bindings.filter((binding) => binding.target === target);
          return (
            <section
              className={`controls-bubble ${highlight === target ? "highlight" : ""}`}
              data-ui={`controls.target.${target}`}
              key={target}
              style={{ left: x, top: y }}
              onMouseEnter={() => setHighlight(target)}
              onMouseLeave={() => setHighlight("")}
              onFocus={() => setHighlight(target)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setHighlight("");
              }}
            >
              <h3>
                {[
                  "a",
                  "b",
                  "game",
                  "time",
                  "pause",
                  "power",
                  "start",
                  "select",
                ].includes(target)
                  ? target === "pause"
                    ? "PAUSE / SET"
                    : target.toUpperCase()
                  : t(`button.${target}`)}
                <small>
                  {target === "power"
                    ? t("controls.side")
                    : model === "mario" && ["start", "select"].includes(target)
                      ? t("controls.extension")
                      : own.some((binding) => binding.turbo !== null)
                        ? "⚡"
                        : ""}
                </small>
              </h3>
              <BindingRow
                bindings={own}
                conflictIds={conflictIds}
                target={target}
                edit={edit}
                remove={remove}
                menu={menu}
              />
            </section>
          );
        })}
        {model === "mario" && (
          <p className="controls-extension-note">
            {t("controls.marioExtension")}
          </p>
        )}
        <p className="controls-legend">
          {t("controls.keyboard")} · {t("controls.gamepad")}　⚡{" "}
          {t("controls.turbo")}　! {t("controls.conflict")}
        </p>
      </div>
    </div>
  );
}
