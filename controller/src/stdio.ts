import { createInterface } from "node:readline";
import { object } from "../../shared/plugin-format.ts";
import type { ControllerCommand } from "../../shared/protocol.ts";

interface Handler {
  submit(id: string, command: ControllerCommand): void;
  report(error: unknown): void;
}
export function bindStdio(
  handler: Handler,
  stop: () => void,
  internal: (value: Record<string, unknown>) => boolean = () => false,
): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    try {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("命令超过大小限制");
      const value: unknown = JSON.parse(line);
      if (!object(value) || typeof value.id !== "string" || typeof value.type !== "string")
        throw new Error("命令必须包含 id 和 type");
      if (internal(value)) return;
      if (value.type === "shutdown") {
        stop();
        return;
      }
      handler.submit(value.id, value as ControllerCommand);
    } catch (error) {
      handler.report(error);
    }
  });
  input.once("close", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.on("error", stop);
}
