import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../../shared/locale";
import { skinImage, type Skin, type SkinButton } from "./chassis-assets";

function ChassisButton({
  skin,
  button,
  runtimeSessionId,
  pressed,
  disabled,
  resetToken,
}: {
  skin: Skin;
  button: SkinButton;
  runtimeSessionId: string;
  pressed: boolean;
  disabled: boolean;
  resetToken: number;
}) {
  const pointers = useRef(new Set<number>());
  const keys = useRef(new Set<string>());
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const previousReset = useRef(resetToken);
  const releasePointer = (id: number) => {
    if (!pointers.current.delete(id)) return;
    window.desktop.button(button.bit, false, `pointer:${id}`, runtimeSessionId);
  };
  const releaseKeys = () => {
    for (const key of keys.current)
      window.desktop.button(
        button.bit,
        false,
        `chassis-key:${button.id}:${key}`,
        runtimeSessionId,
      );
    keys.current.clear();
  };
  useEffect(() => {
    // Window fallback also handles a platform failing to capture the pointer.
    const release = (event: PointerEvent) => releasePointer(event.pointerId);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      for (const id of pointers.current)
        window.desktop.button(
          button.bit,
          false,
          `pointer:${id}`,
          runtimeSessionId,
        );
      pointers.current.clear();
      releaseKeys();
    };
  }, [runtimeSessionId, button.bit, button.id]);
  useEffect(() => {
    if (disabled || resetToken !== previousReset.current) {
      // Aggregate feedback may predate a new local press. Clear ownership only
      // when main explicitly resets input, even if the aggregate mask is unchanged.
      const captured = [...pointers.current];
      pointers.current.clear();
      keys.current.clear();
      for (const id of captured)
        if (ref.current?.hasPointerCapture(id))
          ref.current.releasePointerCapture(id);
      setHover(false);
    }
    previousReset.current = resetToken;
  }, [disabled, resetToken]);
  const rect = button.spriteRect;
  const points = button.shape.points
    ?.map(
      ([x, y]) =>
        `${((x - rect.x) / rect.width) * 100}% ${((y - rect.y) / rect.height) * 100}%`,
    )
    .join(",");
  const style: CSSProperties = {
    left: `${(rect.x / skin.size.width) * 100}%`,
    top: `${(rect.y / skin.size.height) * 100}%`,
    width: `${(rect.width / skin.size.width) * 100}%`,
    height: `${(rect.height / skin.size.height) * 100}%`,
    clipPath: points ? `polygon(${points})` : undefined,
    borderRadius:
      button.shape.kind === "ellipse"
        ? "50%"
        : button.shape.kind === "roundedRect"
          ? "999px"
          : 0,
  };
  const bounds = button.shape.bounds;
  return (
    <button
      ref={ref}
      type="button"
      className="chassis-button"
      style={style}
      data-ui={`chassis.button.${button.id}`}
      data-bit={button.bit}
      aria-label={t(`button.${button.id}`)}
      aria-pressed={pressed}
      disabled={disabled}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(event) => {
        if (event.button !== 0 || disabled) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        pointers.current.add(event.pointerId);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* window fallback above */
        }
        window.desktop.button(
          button.bit,
          true,
          `pointer:${event.pointerId}`,
          runtimeSessionId,
        );
      }}
      onPointerUp={(event) => releasePointer(event.pointerId)}
      onPointerCancel={(event) => releasePointer(event.pointerId)}
      onLostPointerCapture={(event) => releasePointer(event.pointerId)}
      onKeyDown={(event) => {
        if (event.code !== "Space" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || keys.current.has(event.code)) return;
        keys.current.add(event.code);
        window.desktop.button(
          button.bit,
          true,
          `chassis-key:${button.id}:${event.code}`,
          runtimeSessionId,
        );
      }}
      onKeyUp={(event) => {
        if (!keys.current.delete(event.code)) return;
        event.preventDefault();
        event.stopPropagation();
        window.desktop.button(
          button.bit,
          false,
          `chassis-key:${button.id}:${event.code}`,
          runtimeSessionId,
        );
      }}
      onBlur={releaseKeys}
      onClick={(event) => {
        // Assistive technology may activate a button without keyboard/pointer edges.
        if (event.detail === 0 && keys.current.size === 0 && !disabled) {
          const source = `chassis-key:${button.id}:Enter`;
          window.desktop.button(button.bit, true, source, runtimeSessionId);
          window.desktop.button(button.bit, false, source, runtimeSessionId);
        }
      }}
    >
      <img
        aria-hidden="true"
        draggable={false}
        alt=""
        className="chassis-state"
        style={{ opacity: pressed || (hover && !disabled) ? 1 : 0 }}
        src={skinImage(
          skin,
          button.states[pressed ? "pressed" : hover ? "hover" : "normal"],
        )}
      />
      <svg
        className="chassis-focus"
        aria-hidden="true"
        viewBox={`0 0 ${rect.width} ${rect.height}`}
      >
        {button.shape.points ? (
          <polygon
            points={button.shape.points
              .map(([x, y]) => `${x - rect.x},${y - rect.y}`)
              .join(" ")}
          />
        ) : button.shape.kind === "ellipse" ? (
          <ellipse
            cx={rect.width / 2}
            cy={rect.height / 2}
            rx={(bounds![2] - bounds![0]) / 2 - 2}
            ry={(bounds![3] - bounds![1]) / 2 - 2}
          />
        ) : (
          <rect
            x={bounds![0] - rect.x + 2}
            y={bounds![1] - rect.y + 2}
            width={bounds![2] - bounds![0] - 4}
            height={bounds![3] - bounds![1] - 4}
            rx={button.shape.radius}
          />
        )}
      </svg>
    </button>
  );
}

export function ChassisButtons({
  skin,
  runtimeSessionId,
  mask,
  disabled,
  resetGeneration,
}: {
  skin: Skin;
  runtimeSessionId: string;
  mask: number;
  disabled: boolean;
  resetGeneration: number;
}) {
  return (
    <div className="chassis-controls">
      {skin.buttons.map((button) => (
        <ChassisButton
          key={button.id}
          skin={skin}
          button={button}
          runtimeSessionId={runtimeSessionId}
          pressed={!!(mask & (1 << button.bit))}
          disabled={disabled}
          resetToken={resetGeneration}
        />
      ))}
    </div>
  );
}
