import { createServer as httpServer } from "node:http";
import { readFileSync } from "node:fs";
import { Store } from "./store.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
export function createServer(dbPath) {
  const store = new Store(dbPath);
  const server = httpServer((req, res) => {
    const send = (status, data, type = "application/json; charset=utf-8") => {
      const body = Buffer.isBuffer(data)
        ? data
        : Buffer.from(JSON.stringify(data));
      res.writeHead(status, {
        "Content-Type": type,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(body);
    };
    const host = req.headers.host,
      allowed = [
        `127.0.0.1:${server.address().port}`,
        `localhost:${server.address().port}`,
      ];
    if (
      !allowed.includes(host) ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== "http://" + host) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, { error: "Local same-origin access only" });
      return;
    }
    if (req.method !== "GET") {
      send(405, { error: "Read-only API" });
      return;
    }
    let url;
    try {
      url = new URL(req.url, "http://" + host);
    } catch {
      send(400, { error: "Invalid URL" });
      return;
    }
    try {
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        send(
          200,
          readFileSync(new URL("../static/" + file, import.meta.url)),
          type,
        );
        return;
      }
      if (url.pathname === "/api/chats") {
        const p = url.searchParams;
        send(
          200,
          store.search((p.get("q") || "").slice(0, 2000), {
            harness: p.get("harness") || "",
            repo: p.get("repo") || "",
            limit: Number(p.get("limit") ?? 50),
            offset: Number(p.get("offset") ?? 0),
          }),
        );
      } else if (url.pathname === "/api/chat") {
        const chat = store.get(url.searchParams.get("id") || "");
        send(chat ? 200 : 404, chat || { error: "Conversation not found" });
      } else send(404, { error: "Not found" });
    } catch (error) {
      send(error instanceof RangeError ? 400 : 503, {
        error:
          error instanceof RangeError
            ? error.message
            : "Unable to read index; retry shortly",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => store.close());
  return server;
}
