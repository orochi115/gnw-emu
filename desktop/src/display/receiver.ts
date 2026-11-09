import { createServer, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { FrameParser, type WireMessage } from "./frame-parser";
import {
  encodeHeader,
  MessageType,
  MAX_FRAME_BYTES,
} from "../shared/frame-protocol";
export interface DisplayEndpoint {
  port: number;
  ready: Promise<void>;
  events: EventEmitter;
  waitForFrame(): Promise<void>;
  diagnostics(): Record<string, unknown>;
  close(): Promise<void>;
}
export async function createDisplayReceiver(
  onFrame: (frame: WireMessage) => void,
): Promise<DisplayEndpoint> {
  const events = new EventEmitter();
  let socket: Socket | undefined;
  let closed = false;
  let frames = 0;
  let last: Record<string, unknown> = {};
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((r, j) => {
    resolveReady = r;
    rejectReady = j;
  });
  ready.catch(() => {});
  const server = createServer((connection) => {
    if (socket) {
      connection.destroy();
      return;
    }
    socket = connection;
    socket.setNoDelay(true);
    const parser = new FrameParser((message) => {
      if (message.header.type === MessageType.Hello) {
        socket!.write(
          encodeHeader({
            type: MessageType.HelloAck,
            pixelFormat: 1,
            maxFrameBytes: MAX_FRAME_BYTES,
          }),
        );
        resolveReady();
      } else {
        socket!.write(
          encodeHeader({
            type: MessageType.FrameAck,
            sequence: message.header.sequence,
          }),
        );
        frames++;
        last = {
          sequence: String(message.header.sequence),
          width: message.header.width,
          height: message.header.height,
          receivedAt: performance.now(),
        };
        onFrame(message);
        events.emit("frame");
      }
    });
    socket.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (e) {
        rejectReady(e as Error);
        events.emit("failure", e);
        socket!.destroy();
      }
    });
    socket.on("error", (e) => {
      rejectReady(e);
      events.emit("failure", e);
    });
    socket.on("close", () => {
      if (!closed) {
        const e = new Error("画面连接已断开");
        rejectReady(e);
        events.emit("failure", e);
      }
    });
  });
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  return {
    port: (server.address() as import("node:net").AddressInfo).port,
    ready,
    events,
    waitForFrame: () => new Promise<void>((r) => events.once("frame", r)),
    diagnostics: () => ({
      frames,
      ...last,
      ageMs: frames ? performance.now() - Number(last.receivedAt) : null,
    }),
    async close() {
      closed = true;
      socket?.destroy();
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
