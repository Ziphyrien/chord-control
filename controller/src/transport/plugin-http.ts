import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Json, PluginSurface } from "../../../shared/protocol.ts";
import { jsonValue, message, object, text } from "../../../shared/validation.ts";
import type { PluginRuntime, Enqueue } from "../domain/ports.ts";

interface Page {
  pluginId: string;
  revision: string;
  token: string;
  surface: PluginSurface;
}
type Runtime = Pick<PluginRuntime, "ui" | "call" | "revision">;
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self' http://127.0.0.1:*; base-uri 'none'; form-action 'none'";
/** Per-generation URLs are revoked on stop/update. A page only invokes its own plugin. */
export class PluginHttpServer {
  private readonly runtime: Runtime;
  private readonly gate: Enqueue;
  private readonly pages = new Map<string, Page>();
  private server?: Server;
  private port = 0;
  private active = 0;
  constructor(runtime: Runtime, gate: Enqueue) {
    this.runtime = runtime;
    this.gate = gate;
  }
  async start(): Promise<void> {
    if (this.server) throw new Error("插件 UI 服务已启动");
    const server = createServer((request, response) => {
      if (this.active >= 64) {
        response.writeHead(503).end();
        return;
      }
      this.active++;
      void this.handle(request, response)
        .catch((error) => {
          if (!response.headersSent)
            response.writeHead(400, { "Content-Type": "application/json" });
          if (!response.destroyed)
            response.end(JSON.stringify({ ok: false, message: message(error) }));
        })
        .finally(() => {
          this.active--;
        });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 35_000;
    server.timeout = 35_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("插件 UI 端口不可用"));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }
  private current(page: Page): boolean {
    return (
      this.pages.get(page.token) === page && this.runtime.revision(page.pluginId) === page.revision
    );
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = `127.0.0.1:${this.port}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers.host !== host) {
      response.writeHead(403).end();
      return;
    }
    const origin = request.headers.origin;
    if (origin === "null") response.setHeader("Access-Control-Allow-Origin", "null");
    else if (origin && origin !== `http://${host}`) {
      response.writeHead(403).end();
      return;
    }
    const match = /^\/([a-f0-9]{64})\/(ui|rpc)$/.exec(request.url ?? "");
    const page = match ? this.pages.get(match[1]) : undefined;
    if (!page) {
      response.writeHead(404).end();
      return;
    }
    if (!this.current(page)) {
      response.writeHead(410).end("插件已更新，请重新打开界面");
      return;
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "POST");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.writeHead(204).end();
      return;
    }
    if (match![2] === "ui" && request.method === "GET") {
      const current = await this.gate(async () => {
        if (!this.current(page)) return undefined;
        return this.runtime.ui(page.pluginId);
      });
      if (!this.current(page) || current?.revision !== page.revision) {
        response.writeHead(410).end("插件已更新，请重新打开界面");
        return;
      }
      response.setHeader("Content-Security-Policy", CSP);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(current.html);
      return;
    }
    if (
      match![2] !== "rpc" ||
      request.method !== "POST" ||
      !request.headers["content-type"]?.startsWith("application/json")
    ) {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("插件请求过大");
      chunks.push(chunk);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(input) || !jsonValue(input.input)) throw new Error("插件请求格式错误");
    const method = text(input.method, "插件方法", 100),
      value = input.input;
    const result = await this.gate(() => {
      if (!this.current(page)) throw new Error("插件已更新，请重新打开界面");
      return this.runtime.call(page.pluginId, method, value);
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, result }));
  }
  async open(pluginId: string, surface: PluginSurface = "panel"): Promise<Json> {
    if (!this.server?.listening) throw new Error("插件 UI 服务未运行");
    const current = await this.runtime.ui(pluginId);
    for (const page of this.pages.values())
      if (
        page.pluginId === pluginId &&
        page.surface === surface &&
        page.revision === current.revision
      )
        return this.address(page);
    this.revoke(pluginId, surface);
    const page: Page = {
      pluginId,
      surface,
      revision: current.revision,
      token: randomBytes(32).toString("hex"),
    };
    this.pages.set(page.token, page);
    return this.address(page);
  }
  private address(page: Page): Json {
    return {
      url: `http://127.0.0.1:${this.port}/${page.token}/ui#${page.surface}`,
      revision: page.revision,
    };
  }
  revoke(pluginId: string, surface?: PluginSurface): void {
    for (const [token, page] of this.pages)
      if (page.pluginId === pluginId && (!surface || page.surface === surface))
        this.pages.delete(token);
  }
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.pages.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}
