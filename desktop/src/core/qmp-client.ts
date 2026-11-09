import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "pino";
export class QmpClient extends EventEmitter {
  private server?: Server;
  private socket?: Socket;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      startedAt: number;
      execute: string;
    }
  >();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  constructor(private logger?: Logger) {
    super();
    this.ready.catch(() => {});
  }
  async listen() {
    this.server = createServer((socket) => {
      if (this.socket) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", (data) => {
        try {
          this.buffer += this.decoder.write(data);
          if (this.buffer.length > 1024 * 1024)
            throw new Error("QMP message too large");
          let end: number;
          while ((end = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, end).trim();
            this.buffer = this.buffer.slice(end + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            if (message.QMP)
              this.command("qmp_capabilities").then(
                this.readyResolve,
                this.readyReject,
              );
            else if (message.event) {
              this.logger?.debug(
                { event: "qmp.event", type: message.event },
                "QMP event",
              );
              this.emit("event", message);
            } else {
              const request = this.pending.get(message.id);
              if (!request) continue;
              this.logger?.debug(
                {
                  event: "command.completed",
                  requestId: String(message.id),
                  command: request.execute,
                  durationMs: performance.now() - request.startedAt,
                  error: message.error,
                },
                "QMP completed",
              );
              clearTimeout(request.timer);
              this.pending.delete(message.id);
              if (message.error) request.reject(new Error(message.error.desc));
              else request.resolve(message.return);
            }
          }
        } catch (e) {
          this.fail(e as Error);
          socket.destroy();
        }
      });
      socket.on("error", (e) => this.fail(e));
      socket.on("close", () => {
        this.fail(new Error("QMP disconnected"));
        this.emit("disconnect");
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    return (this.server.address() as import("node:net").AddressInfo).port;
  }
  command(
    execute: string,
    args?: Record<string, unknown>,
    timeout = 5000,
  ): Promise<any> {
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new Error("QMP unavailable"));
    const id = ++this.sequence;
    this.logger?.debug(
      {
        event: "command.sent",
        requestId: String(id),
        command: execute,
        arguments: args,
      },
      "QMP sent",
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QMP timeout: ${execute}`));
      }, timeout);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        startedAt: performance.now(),
        execute,
      });
      this.socket!.write(
        JSON.stringify({ execute, arguments: args, id }) + "\n",
      );
    });
  }
  private fail(error: Error) {
    this.readyReject(error);
    for (const r of this.pending.values()) {
      clearTimeout(r.timer);
      r.reject(error);
    }
    this.pending.clear();
  }
  async close() {
    this.socket?.destroy();
    this.fail(new Error("QMP closed"));
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
