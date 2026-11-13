import { LCD_WIDTH, LCD_HEIGHT } from "../../shared/clock-geometry";
import { t } from "../../shared/locale";
import { useEffect, useRef } from "react";
import { skins, skinImage, type Skin } from "./chassis-assets";
import { ChassisButtons } from "./ChassisButtons";
export function GameScreen({
  runtimeSessionId,
  model,
  showChassis,
  renderScale,
  mask,
  disabled,
  resetGeneration,
}: {
  runtimeSessionId?: string;
  model?: "zelda" | "mario";
  showChassis: boolean;
  renderScale: number | null;
  mask: number;
  disabled: boolean;
  resetGeneration: number;
}) {
  const frameImage = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const skin =
    showChassis && model && runtimeSessionId ? skins[model] : undefined;
  const scaleRef = useRef(renderScale);
  scaleRef.current = renderScale;
  const skinRef = useRef<Skin | undefined>(skin);
  skinRef.current = skin;
  const resizeRef = useRef<() => void>(() => {});
  useEffect(() => {
    resizeRef.current();
  }, [skin, runtimeSessionId, renderScale]);
  useEffect(() => {
    let port: MessagePort | undefined;
    let animation = 0;
    let pending: any;
    let currentId: string | undefined;
    let receivedAt = 0;
    const resize = () => {
      if (!container.current || !canvas.current) return;
      const box = container.current.getBoundingClientRect();
      const chassis = skinRef.current;
      const factor = scaleRef.current ?? 1;
      const actual = scaleRef.current !== null;
      if (frameImage.current) frameImage.current.style.clipPath = "";
      const density = window.devicePixelRatio;
      const c = canvas.current;
      c.style.transform = actual ? `scale(${factor / density})` : "";
      c.style.transformOrigin = "top left";
      c.style.maxWidth = actual ? "none" : "";
      c.style.maxHeight = actual ? "none" : "";
      c.dataset.devicePixelRatio = String(density);
      // Layout uses hardware LCD pixels, independently of the transport resolution.
      // Blink quantizes fractional CSS sizes; LCD-size + transform avoids it.
      const sizeCanvas = (scale: number) => {
        c.style.width = `${LCD_WIDTH * (actual ? 1 : scale)}px`;
        c.style.height = `${LCD_HEIGHT * (actual ? 1 : scale)}px`;
      };
      const placeCanvas = (x: number, y: number) => {
        const rect = layout.current!.getBoundingClientRect();
        c.style.left = `${actual ? Math.round((rect.x + x) * density) / density - rect.x : x}px`;
        c.style.top = `${actual ? Math.round((rect.y + y) * density) / density - rect.y : y}px`;
      };
      if (chassis && layout.current) {
        const availableWidth = Math.max(1, box.width),
          availableHeight = Math.max(1, box.height);
        const scale = actual
          ? (LCD_WIDTH * factor) / (chassis.screen.width * density)
          : Math.min(
              availableWidth / chassis.size.width,
              availableHeight / chassis.size.height,
            );
        layout.current.style.width = `${chassis.size.width * scale}px`;
        layout.current.style.height = `${chassis.size.height * scale}px`;
        const aperture = chassis.screen;
        const lcdScale = actual
          ? factor / density
          : Math.min(aperture.width / LCD_WIDTH, aperture.height / LCD_HEIGHT) *
            scale;
        c.style.position = "absolute";
        sizeCanvas(lcdScale);
        placeCanvas(
          (aperture.x + aperture.width / 2) * scale -
            (LCD_WIDTH * lcdScale) / 2,
          (aperture.y + aperture.height / 2) * scale -
            (LCD_HEIGHT * lcdScale) / 2,
        );
        if (actual && frameImage.current) {
          // Photo alpha filtering must not tint the first/last LCD pixel rows.
          const r = layout.current.getBoundingClientRect();
          const x = parseFloat(c.style.left),
            y = parseFloat(c.style.top),
            w = (LCD_WIDTH * factor) / density,
            h = (LCD_HEIGHT * factor) / density;
          frameImage.current.style.clipPath = `path(evenodd, "M0 0 H${r.width} V${r.height} H0 Z M${x} ${y} h${w} v${h} h${-w} Z")`;
        }

        return;
      }
      if (layout.current) {
        layout.current.style.width = "100%";
        layout.current.style.height = "100%";
      }
      c.style.position = actual ? "absolute" : "";
      if (actual) {
        sizeCanvas(factor / density);
        placeCanvas(
          (box.width - (LCD_WIDTH * factor) / density) / 2,
          (box.height - (LCD_HEIGHT * factor) / density) / 2,
        );
        return;
      }
      canvas.current.style.left = "";
      canvas.current.style.top = "";
      const fit = Math.min(box.width / LCD_WIDTH, box.height / LCD_HEIGHT);
      const scale = fit;
      canvas.current.style.width = `${LCD_WIDTH * scale}px`;
      canvas.current.style.height = `${LCD_HEIGHT * scale}px`;
    };
    resizeRef.current = resize;
    let resolution: MediaQueryList;
    const watchDensity = () => {
      resolution?.removeEventListener("change", watchDensity);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      resolution.addEventListener("change", watchDensity);
      resize();
    };
    watchDensity();
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    const draw = () => {
      animation = 0;
      if (!pending || !canvas.current) return;
      const frame = pending;
      pending = undefined;
      const c = canvas.current;
      const sourceWidth = frame.width;
      const sourceHeight = frame.height;
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
      resolution.removeEventListener("change", watchDensity);
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
          width={LCD_WIDTH}
          height={LCD_HEIGHT}
          aria-label={t("app.game")}
          data-ui="game.canvas"
          tabIndex={-1}
          onPointerDown={(event) => event.currentTarget.focus()}
        />
        {skin && (
          <>
            <img
              ref={frameImage}
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
