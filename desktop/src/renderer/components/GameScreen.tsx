import { useEffect, useRef } from "react";
export function GameScreen({
  runtimeSessionId,
}: {
  runtimeSessionId?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
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
      const fit = Math.min(box.width / sourceWidth, box.height / sourceHeight);
      const scale = fit >= 1 ? Math.floor(fit) : fit;
      canvas.current.style.width = `${sourceWidth * scale}px`;
      canvas.current.style.height = `${sourceHeight * scale}px`;
    };
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
    <div ref={container} className="game-screen" hidden={!runtimeSessionId}>
      <canvas
        ref={canvas}
        width={320}
        height={240}
        aria-label="游戏画面"
        data-ui="game.canvas"
      />
    </div>
  );
}
