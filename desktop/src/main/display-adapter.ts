import {
  utilityProcess,
  MessageChannelMain,
  type BrowserWindow,
} from "electron";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { DisplayEndpoint } from "../display/receiver";
import type { Logger } from "pino";
import { deadline } from "../core/session-controller";
export async function startDisplay(
  window: BrowserWindow,
  id: string,
  logger?: Logger,
): Promise<DisplayEndpoint> {
  const child = utilityProcess.fork(
    join(import.meta.dirname, "utility.js"),
    [],
    { serviceName: "Game display", stdio: "pipe" },
  );
  const log = logger?.child({ runtimeSessionId: id, source: "utility" });
  child.stderr?.on("data", (chunk) =>
    log?.debug(
      { event: "output", text: chunk.toString().slice(0, 8192) },
      "Display utility output",
    ),
  );
  const events = new EventEmitter();
  let stats: Record<string, unknown> = {};
  let closed = false;
  let seenFrame = false;
  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  ready.catch(() => {});
  let portResolve!: (port: number) => void;
  let portReject!: (e: Error) => void;
  const portPromise = new Promise<number>((r, j) => {
    portResolve = r;
    portReject = j;
  });
  child.on("message", (message) => {
    if (message.runtimeSessionId !== id) return;
    if (message.type === "ready") portResolve(message.port);
    if (message.type === "handshake") {
      log?.info({ event: "handshake" }, "Display connected");
      readyResolve();
    }
    if (message.type === "frame") {
      seenFrame = true;
      events.emit("frame");
    }
    if (message.type === "stats") {
      stats = message;
      log?.trace({ event: "stats", ...message }, "Display statistics");
    }
    if (message.type === "failure") {
      const e = new Error(message.error);
      log?.error({ event: "failure", err: e }, "Display failed");
      readyReject(e);
      portReject(e);
      events.emit("failure", e);
    }
  });
  child.on("exit", (code) => {
    if (!closed) {
      const e = new Error(`画面接收进程退出 (${code})`);
      portReject(e);
      readyReject(e);
      events.emit("failure", e);
    }
  });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: "attach", runtimeSessionId: id }, [port2]);
  window.webContents.postMessage("display-port", { runtimeSessionId: id }, [
    port1,
  ]);
  try {
    const port = await deadline(portPromise, 10000, "准备画面端点");
    return {
      port,
      ready,
      events,
      waitForFrame: () => {
        const next = new Promise<void>((r) => events.once("frame", r));
        child.postMessage({ type: "frame-wait" });
        return next;
      },
      diagnostics: () => stats,
      async close() {
        closed = true;
        child.postMessage({ type: "close" });
        await deadline(
          new Promise<void>((r) => child.once("exit", () => r())),
          2000,
          "关闭画面接收端",
        ).catch(() => child.kill());
      },
    };
  } catch (e) {
    closed = true;
    child.kill();
    throw e;
  }
}
