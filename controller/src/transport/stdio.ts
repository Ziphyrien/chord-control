import type { Readable, Writable } from "node:stream";
import { parseCommand } from "../../../shared/commands.ts";
import type { ControllerCommand, ControllerEvent } from "../../../shared/protocol.ts";
import { message, object, text } from "../../../shared/validation.ts";

interface Handler {
  submit(id: string, command: ControllerCommand): Promise<void>;
  internal(value: unknown): boolean;
  stop(): void;
}
/** Bounded framing and correlation live here; command semantics do not depend on Node streams. */
export class StdioTransport {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly handler: Handler;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Set<string>();
  private ended = false;
  private stopping = false;
  constructor(input: Readable, output: Writable, handler: Handler) {
    this.input = input;
    this.output = output;
    this.handler = handler;
  }
  emit = (event: ControllerEvent | object): void => {
    if (this.output.destroyed) throw new Error("控制器输出已断开");
    if (this.output.writableLength > 4 * 1024 * 1024) throw new Error("控制器输出阻塞");
    this.output.write(JSON.stringify(event) + "\n");
  };
  start(): void {
    this.input.on("data", this.receive);
    this.input.once("end", this.stop);
    this.input.once("error", this.stop);
    this.output.once("error", this.stop);
  }
  private stop = (): void => {
    if (!this.stopping) {
      this.stopping = true;
      this.handler.stop();
    }
  };
  private receive = (chunk: Buffer | string): void => {
    if (this.ended) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let boundary: number;
    while ((boundary = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, boundary);
      this.buffer = this.buffer.subarray(boundary + 1);
      if (line.length > 2 * 1024 * 1024) {
        this.emit({ type: "error", message: "命令超过大小限制" });
        this.stop();
        return;
      }
      if (line.length) this.line(line);
    }
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.emit({ type: "error", message: "命令超过大小限制" });
      this.stop();
    }
  };
  private line(line: Buffer): void {
    let id: string | undefined;
    try {
      const value: unknown = JSON.parse(line.toString("utf8"));
      if (this.handler.internal(value)) return;
      if (!object(value)) throw new Error("命令必须是对象");
      id = text(value.id, "请求标识", 150);
      if (value.type === "shutdown") {
        this.stop();
        return;
      }
      if (this.stopping) throw new Error("控制器正在关闭");
      if (this.pending.has(id)) throw new Error("请求标识重复");
      if (this.pending.size >= 128) throw new Error("并行请求过多");
      const command = parseCommand(value),
        key = id;
      this.pending.add(key);
      void this.handler
        .submit(key, command)
        .catch((error) =>
          this.emit({ type: "response", id: key, ok: false, message: message(error) }),
        )
        .finally(() => this.pending.delete(key));
    } catch (error) {
      this.emit(
        id
          ? { type: "response", id, ok: false, message: message(error) }
          : { type: "error", message: message(error) },
      );
    }
  }
  close(): void {
    this.input.removeListener("data", this.receive);
    this.input.removeListener("end", this.stop);
    this.input.removeListener("error", this.stop);
    this.output.removeListener("error", this.stop);
    this.buffer = Buffer.alloc(0);
    this.ended = true;
  }
}
