/**
 * noVNC viewer for agent-sandbox desktop sessions.
 *
 * Exists because a browser cannot set an Authorization header on a WebSocket,
 * and GET /exec/:id/vnc is deliberately header-only Bearer — no ?access_token=,
 * since a token in a URL ends up in access logs, browser history and Referer.
 *
 * So the browser talks to this process without credentials, and this process
 * holds the API key and adds the header when it dials the sandbox. It binds
 * loopback only: reach it through an SSH tunnel, never by exposing the port.
 *
 *   SANDBOX_KEY=sk_... node server.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOVNC = path.join(HERE, "node_modules", "@novnc", "novnc");

const PORT = Number(process.env.VIEWER_PORT ?? 6080);
const SANDBOX = process.env.SANDBOX_URL ?? "http://127.0.0.1:3000";
const KEY = process.env.SANDBOX_KEY;

if (!KEY) {
  console.error("SANDBOX_KEY is required (the exec-scoped API key).");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Serve one file from the noVNC package, refusing anything outside it. */
async function serveNovnc(urlPath, res) {
  const rel = decodeURIComponent(urlPath.replace(/^\/novnc\//, ""));
  const abs = path.resolve(NOVNC, rel);
  if (!abs.startsWith(NOVNC + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(abs);
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/** Call the sandbox REST API with the key this process holds. */
async function sandbox(pathname, init = {}) {
  const res = await fetch(`${SANDBOX}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.text() };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    const html = await readFile(path.join(HERE, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (url.pathname.startsWith("/novnc/")) return serveNovnc(url.pathname, res);

  // Thin pass-through so the page can list and start sessions without ever
  // seeing the key.
  if (url.pathname === "/api/sessions") {
    const r = await sandbox("/exec/");
    res.writeHead(r.status, { "Content-Type": "application/json" });
    return res.end(r.body);
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    const id = url.searchParams.get("session");
    if (!id) return res.writeHead(400).end('{"error":"session required"}');
    // Any command works; the point is to boot the VM so the VNC port is live.
    const r = await sandbox(`/exec/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      body: JSON.stringify({ template: "desktop", command: "sh", args: ["-c", "echo ready"] }),
    });
    res.writeHead(r.status, { "Content-Type": "application/json" });
    return res.end(r.body);
  }

  res.writeHead(404).end("not found");
});

// ---------------------------------------------------------------------------
// WebSocket bridge: browser (no credentials) <-> sandbox (Bearer header)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/websockify") {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const target = `${SANDBOX.replace(/^http/, "ws")}/exec/${encodeURIComponent(sessionId)}/vnc`;
    const upstream = new WebSocket(target, { headers: { Authorization: `Bearer ${KEY}` } });

    // RFB bytes can arrive before the browser socket finishes opening, and a
    // dropped greeting desynchronises the whole protocol. Queue until ready.
    const pending = [];
    const toClient = (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
      else pending.push(data);
    };

    client.on("open", () => {
      while (pending.length) client.send(pending.shift(), { binary: true });
    });

    upstream.on("open", () => {
      console.log(`[bridge] ${sessionId}: connected`);
      while (pending.length && client.readyState === WebSocket.OPEN) {
        client.send(pending.shift(), { binary: true });
      }
    });

    upstream.on("message", (data) => toClient(data));
    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
    });

    const shutdown = (who) => (codeOrErr) => {
      const detail = codeOrErr instanceof Error ? codeOrErr.message : `code=${codeOrErr}`;
      console.log(`[bridge] ${sessionId}: ${who} closed (${detail})`);
      try { client.close(); } catch {}
      try { upstream.close(); } catch {}
    };

    upstream.on("close", shutdown("sandbox"));
    upstream.on("error", shutdown("sandbox"));
    client.on("close", shutdown("browser"));
    client.on("error", shutdown("browser"));

    upstream.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.error(`[bridge] ${sessionId}: sandbox refused upgrade: HTTP ${res.statusCode} ${body.slice(0, 200)}`);
        try { client.close(1011, `sandbox HTTP ${res.statusCode}`); } catch {}
      });
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`noVNC viewer on http://127.0.0.1:${PORT}  ->  ${SANDBOX}`);
  console.log("loopback only: reach it over an SSH tunnel.");
});
