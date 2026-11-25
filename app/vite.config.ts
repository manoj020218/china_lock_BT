/// <reference types="node" />
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import packageJson from "./package.json";

// Dev-only proxy so the browser can reach a gateway's plain-HTTP API without
// CORS: the app calls /__gw/<host>/api/... and this middleware forwards it to
// http://<host>/api/.... Not used in the native app (it uses CapacitorHttp).
function gatewayProxy(): Plugin {
  return {
    name: "jenix-gateway-proxy",
    configureServer(server) {
      server.middlewares.use("/__gw", async (req, res) => {
        const m = (req.url ?? "").match(/^\/([^/]+)(\/.*)$/);
        if (!m) {
          res.statusCode = 400;
          res.end("bad proxy path");
          return;
        }
        const target = `http://${decodeURIComponent(m[1])}${m[2]}`;
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === "host" || k === "content-length" || k === "connection") continue;
          if (typeof v === "string") headers[k] = v;
        }
        try {
          const r = await fetch(target, {
            method: req.method,
            headers,
            body: req.method === "GET" || req.method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks)
          });
          res.statusCode = r.status;
          const ct = r.headers.get("content-type");
          if (ct) res.setHeader("content-type", ct);
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(`gateway unreachable: ${String(e)}`);
        }
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), gatewayProxy()],
  server: { host: true },
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) }
});
