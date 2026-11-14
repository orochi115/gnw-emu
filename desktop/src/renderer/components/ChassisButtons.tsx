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
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const previousReset = useRef(resetToken);
  const releasePointer = (id: number) => {
    if (!pointers.current.delete(id)) return;
    window.desktop.button(button.bit, false, `pointer:${id}`, runtimeSessionId);
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
    };
  }, [runtimeSessionId, button.bit, button.id]);
  useEffect(() => {
    if (disabled || resetToken !== previousReset.current) {
      // Aggregate feedback may predate a new local press. Clear ownership only
      // when main explicitly resets input, even if the aggregate mask is unchanged.
      const captured = [...pointers.current];
      pointers.current.clear();
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
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
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
