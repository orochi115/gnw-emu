import { t } from "../../shared/locale";
import { useEffect, useRef } from "react";
import { skins, skinImage, type Skin } from "./chassis-assets";
import { ChassisButtons } from "./ChassisButtons";
export function GameScreen({
  runtimeSessionId,
  model,
  showChassis,
  mask,
  disabled,
  resetGeneration,
}: {
  runtimeSessionId?: string;
  model?: "zelda" | "mario";
  showChassis: boolean;
  mask: number;
  disabled: boolean;
  resetGeneration: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const skin =
    showChassis && model && runtimeSessionId ? skins[model] : undefined;
  const skinRef = useRef<Skin | undefined>(skin);
  skinRef.current = skin;
  const resizeRef = useRef<() => void>(() => {});
  useEffect(() => {
    resizeRef.current();
  }, [skin, runtimeSessionId]);
  useEffect(() => {
    let port: MessagePort | undefined;
    let animation = 0;
    let pending: any;
    let currentId: string | undefined;
    let receivedAt = 0;
    let sourceWidth = 320;
    let sourceHeight = 240;
    const resize = () => {
      if (!container.current || !canvas.current) return;
      const box = container.current.getBoundingClientRect();
      const chassis = skinRef.current;
      if (chassis && layout.current) {
        const availableWidth = Math.max(1, box.width - 32),
          availableHeight = Math.max(1, box.height - 32);
        const scale = Math.min(
          availableWidth / chassis.size.width,
          availableHeight / chassis.size.height,
        );
        layout.current.style.width = `${chassis.size.width * scale}px`;
        layout.current.style.height = `${chassis.size.height * scale}px`;
        const aperture = chassis.screen;
        const lcdScale =
          Math.min(
            aperture.width / sourceWidth,
            aperture.height / sourceHeight,
          ) * scale;
        canvas.current.style.width = `${sourceWidth * lcdScale}px`;
        canvas.current.style.height = `${sourceHeight * lcdScale}px`;
        canvas.current.style.left = `${(aperture.x + aperture.width / 2) * scale - (sourceWidth * lcdScale) / 2}px`;
        canvas.current.style.top = `${(aperture.y + aperture.height / 2) * scale - (sourceHeight * lcdScale) / 2}px`;
        return;
      }
      if (layout.current) {
        layout.current.style.width = "100%";
        layout.current.style.height = "100%";
      }
      canvas.current.style.left = "";
      canvas.current.style.top = "";
      const fit = Math.min(box.width / sourceWidth, box.height / sourceHeight);
      const scale = fit >= 1 ? Math.floor(fit) : fit;
      canvas.current.style.width = `${sourceWidth * scale}px`;
      canvas.current.style.height = `${sourceHeight * scale}px`;
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    const draw = () => {
      animation = 0;
      if (!pending || !canvas.current) return;
      const frame = pending;
      pending = undefined;
      const c = canvas.current;
      sourceWidth = frame.width;
      sourceHeight = frame.height;
      if (c.width !== sourceWidth || c.height !== sourceHeight) {
        c.width = sourceWidth;
        c.height = sourceHeight;
        resize();
      }
      const context = c.getContext("2d", { alpha: false })!;
      context.imageSmoothingEnabled = false;
      context.putImageData(
        new ImageData(
          new Uint8ClampedArray(frame.pixels),
          sourceWidth,
          sourceHeight,
        ),
        0,
        0,
      );
      c.dataset.lastPresented = frame.sequence;
      c.dataset.presentedAt = String(performance.now());
      c.dataset.receiveToDrawMs = String(performance.now() - receivedAt);
      c.dataset.frames = String(Number(c.dataset.frames ?? 0) + 1);
      port?.postMessage({
        type: "consumed",
        runtimeSessionId: frame.runtimeSessionId,
      });
    };
    const attach = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== "gnw-display") return;
      port?.close();
      cancelAnimationFrame(animation);
      animation = 0;
      pending = undefined;
      currentId = event.data.runtimeSessionId;
      port = event.ports[0];
      if (!port) return;
      cReset(event.data.runtimeSessionId);
      port.onmessage = (e) => {
        if (e.data.runtimeSessionId !== currentId) return;
        receivedAt = performance.now();
        pending = e.data;
        canvas.current!.dataset.lastReceived = e.data.sequence;
        if (!animation) animation = requestAnimationFrame(draw);
      };
      port.start();
    };
    const cReset = (id: string) => {
      if (canvas.current) {
        canvas.current.dataset.runtimeSessionId = id;
        canvas.current.dataset.frames = "0";
      }
    };
    window.addEventListener("message", attach);
    resize();
    return () => {
      window.removeEventListener("message", attach);
      observer.disconnect();
      port?.close();
      cancelAnimationFrame(animation);
    };
  }, []);
  return (
    <div
      ref={container}
      className={`game-screen${skin ? " with-chassis" : ""}`}
      hidden={!runtimeSessionId}
    >
      <div
        ref={layout}
        className={skin ? "chassis" : "plain-screen"}
        data-ui={skin ? "chassis" : undefined}
        data-model={skin?.model}
        aria-label={
          skin
            ? t("chassis.device", {
                model: skin.model === "zelda" ? "Zelda" : "Mario",
              })
            : undefined
        }
      >
        <canvas
          ref={canvas}
          width={320}
          height={240}
          aria-label={t("app.game")}
          data-ui="game.canvas"
          tabIndex={-1}
          onPointerDown={(event) => event.currentTarget.focus()}
        />
        {skin && (
          <>
            <img
              className="chassis-frame"
              src={skinImage(skin, "frame.png")}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            <ChassisButtons
              skin={skin}
              runtimeSessionId={runtimeSessionId!}
              mask={mask}
              disabled={disabled}
              resetGeneration={resetGeneration}
            />
          </>
        )}
      </div>
    </div>
  );
}
