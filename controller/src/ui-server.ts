import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { isJsonValue } from "@earendil-works/chord";
import type { Json } from "../../shared/protocol.ts";
import { object } from "../../shared/plugin-format.ts";
import type { PluginUi, Enqueue } from "./ports.ts";

/** Local plugin pages get an unguessable, per-generation RPC URL and no Tauri IPC. */
export class PluginUiServer {
  private server?: Server;
  private port = 0;
  private readonly pages = new Map<string, { id: string; revision: string }>();
  constructor(
    private readonly runtime: PluginUi,
    private readonly enqueue: Enqueue,
  ) {}
  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void (async () => {
        const host = `127.0.0.1:${this.port}`;
        if (request.headers.host !== host) {
          response.writeHead(403).end();
          return;
        }
        const [, token, action] = (request.url ?? "").split("/");
        const page = this.pages.get(token);
        if (!page) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        // Sandboxed iframe requests have an opaque origin; the capability is the URL token.
        if (request.headers.origin === "null")
          response.setHeader("Access-Control-Allow-Origin", "null");
        else if (request.headers.origin && request.headers.origin !== `http://${host}`) {
          response.writeHead(403).end();
          return;
        }
        if (request.method === "OPTIONS") {
          response.setHeader("Access-Control-Allow-Methods", "POST");
          response.setHeader("Access-Control-Allow-Headers", "Content-Type");
          response.writeHead(204).end();
          return;
        }
        if (action === "ui" && request.method === "GET") {
          const value = await this.enqueue(() => this.runtime.ui(page.id));
          if (!object(value) || value.revision !== page.revision) {
            response.writeHead(410).end("插件已更新，请重新打开界面");
            return;
          }
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self' http://127.0.0.1:*; base-uri 'none'; form-action 'none'",
          );
          response.end(value.html);
          return;
        }
        if (
          action === "rpc" &&
          request.method === "POST" &&
          request.headers["content-type"]?.startsWith("application/json")
        ) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) throw new Error("插件请求过大");
            chunks.push(chunk);
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
          if (!object(body) || typeof body.method !== "string" || !isJsonValue(body.input))
            throw new Error("插件请求格式错误");
          const result = await this.enqueue(async () => {
            const current = await this.runtime.ui(page.id);
            if (!object(current) || current.revision !== page.revision)
              throw new Error("插件已更新，请重新打开界面");
            return this.runtime.call(page.id, body.method as string, body.input as Json);
          });
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, result }));
          return;
        }
        response.writeHead(404).end();
      })().catch((error) => {
        if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
    this.server.requestTimeout = 35_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address !== "string") this.port = address.port;
        resolve();
      });
    });
  }
  async open(id: string): Promise<Json> {
    const value = await this.runtime.ui(id);
    if (!object(value) || typeof value.revision !== "string") throw new Error("插件 UI 无效");
    for (const [token, page] of this.pages) {
      if (page.id !== id) continue;
      if (page.revision === value.revision)
        return { url: `http://127.0.0.1:${this.port}/${token}/ui`, revision: value.revision };
      this.pages.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    this.pages.set(token, { id, revision: value.revision });
    return { url: `http://127.0.0.1:${this.port}/${token}/ui`, revision: value.revision };
  }
  close(): void {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
