import { createDisplayReceiver } from "./receiver";
import { LatestDelivery } from "./delivery";
import type { WireMessage } from "./frame-parser";
const parent = process.parentPort!;
parent.on("message", async (event) => {
  if (event.data.type !== "attach") return;
  const port = event.ports[0];
  const id = event.data.runtimeSessionId;
  const delivery = new LatestDelivery<WireMessage>((frame) =>
    port.postMessage({
      runtimeSessionId: id,
      sequence: String(frame.header.sequence),
      captureTimeNs: String(frame.header.captureTimeNs),
      width: frame.header.width,
      height: frame.header.height,
      pixels: frame.pixels,
    }),
  );
  port.on("message", (event) => {
    if (event.data.type === "consumed" && event.data.runtimeSessionId === id)
      delivery.consumed();
  });
  port.start();
  try {
    const receiver = await createDisplayReceiver((frame) =>
      delivery.offer(frame),
    );
    let first = true;
    parent.on("message", (e) => {
      if (e.data.type === "frame-wait") first = true;
    });
    receiver.ready.then(
      () => parent.postMessage({ type: "handshake", runtimeSessionId: id }),
      (e) =>
        parent.postMessage({
          type: "failure",
          error: e.message,
          runtimeSessionId: id,
        }),
    );
    receiver.events.on("frame", () => {
      if (first) {
        first = false;
        parent.postMessage({ type: "frame", runtimeSessionId: id });
      }
    });
    receiver.events.on("failure", (e) =>
      parent.postMessage({
        type: "failure",
        error: e.message,
        runtimeSessionId: id,
      }),
    );
    parent.postMessage({
      type: "ready",
      port: receiver.port,
      runtimeSessionId: id,
    });
    const timer = setInterval(
      () =>
        parent.postMessage({
          type: "stats",
          runtimeSessionId: id,
          ...receiver.diagnostics(),
          utilityMemory: process.memoryUsage(),
          queued: delivery.queued,
          dropped: delivery.dropped,
        }),
      1000,
    );
    parent.on("message", async (e) => {
      if (e.data.type === "close") {
        clearInterval(timer);
        await receiver.close();
        port.close();
        process.exit(0);
      }
    });
  } catch (e) {
    parent.postMessage({
      type: "failure",
      error: (e as Error).message,
      runtimeSessionId: id,
    });
  }
});
