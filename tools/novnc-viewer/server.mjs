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

// ---------------------------------------------------------------------------
// Origin and Host checks
// ---------------------------------------------------------------------------
// Binding 127.0.0.1 keeps other hosts out. It does nothing about the browser
// already running on this machine: WebSocket handshakes are exempt from the
// same-origin policy — no preflight, no CORS — so any page on any site the
// operator visits can open ws://127.0.0.1:6080/websockify?session=desk-1, and
// this process would dutifully attach the API key to the upstream dial. That
// hands a live RFB channel, keyboard and mouse included, to a page the operator
// merely visited. Session ids need no discovering; the docs use `desk-1`.
const ALLOWED_ORIGINS = new Set(
  (process.env.VIEWER_ALLOWED_ORIGINS ??
    `http://127.0.0.1:${PORT},http://localhost:${PORT},http://[::1]:${PORT}`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function originAllowed(req) {
  const origin = req.headers.origin;
  // Browsers always send Origin on a WebSocket handshake and on a cross-site
  // POST. A request carrying none is a non-browser client — curl, a node
  // script — which is not this threat: the attack requires a victim's browser.
  if (origin === undefined) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function hostAllowed(req) {
  // DNS rebinding: a page served from attacker.example, whose name has been
  // repointed at 127.0.0.1, is same-origin to the browser — so it sends no
  // Origin at all and the check above passes it. The Host header still carries
  // the attacker's name, which is what catches it.
  const name = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
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

  if (!hostAllowed(req) || !originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end('{"error":"forbidden: unexpected Origin or Host"}');
  }

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
// RFB is already a binary stream; src/routes/vnc.ts disables compression on the
// same bytes for the same reason, and paying for it twice on one hop is worse.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/websockify") {
    socket.destroy();
    return;
  }
  if (!hostAllowed(req) || !originAllowed(req)) {
    console.warn(
      `[bridge] refused upgrade from Origin=${req.headers.origin ?? "(none)"} Host=${req.headers.host ?? "(none)"}`,
    );
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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
    const upstream = new WebSocket(target, {
      headers: { Authorization: `Bearer ${KEY}` },
      perMessageDeflate: false,
    });

    // The socket handleUpgrade hands back is already OPEN — a server-side `ws`
    // socket never emits `open`, that is a client-side event — so there is
    // nothing to queue in this direction. It is `upstream` that opens late, and
    // it cannot deliver a message before it is open. What can happen is the
    // browser sending before upstream is ready, so that is the side that queues.
    const pending = [];

    upstream.on("open", () => {
      console.log(`[bridge] ${sessionId}: connected`);
      while (pending.length) upstream.send(pending.shift(), { binary: true });
    });

    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
    });

    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
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
