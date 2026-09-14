/**
 * Operator console for a running agent-sandbox.
 *
 * Serves a page that shows a desktop session live, runs commands in it, browses
 * its files, and drives it with scripted agent tasks — all against the real
 * REST and VNC API, with no special-case server support.
 *
 * It exists as a proxy for the same reason tools/novnc-viewer does: the browser
 * WebSocket API cannot set an Authorization header, and /exec/:id/vnc reads the
 * header only — a token in a URL would land in access logs, browser history and
 * Referer. So this process holds the key and the browser never sees it.
 *
 *   SANDBOX_KEY=sk_... node server.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { listTasks, getTask, runTask } from "./agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOVNC = path.join(HERE, "node_modules", "@novnc", "novnc");

const PORT = Number(process.env.CONSOLE_PORT ?? 6090);
const SANDBOX = process.env.SANDBOX_URL ?? "http://127.0.0.1:3000";
const KEY = process.env.SANDBOX_KEY;

if (!KEY) {
  console.error("SANDBOX_KEY is required (an API key with the exec scope).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Origin and Host checks
// ---------------------------------------------------------------------------
// Loopback binding stops other hosts, not a page in the operator's own browser:
// WebSocket handshakes are exempt from the same-origin policy, so without this
// any site could open the bridge and have us attach the API key for it. Host is
// checked too — a name DNS-rebound to 127.0.0.1 is same-origin to the browser
// and therefore sends no Origin at all.
const ALLOWED_ORIGINS = new Set(
  (process.env.CONSOLE_ALLOWED_ORIGINS ??
    `http://127.0.0.1:${PORT},http://localhost:${PORT},http://[::1]:${PORT}`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function originAllowed(req) {
  const origin = req.headers.origin;
  // No Origin at all is a non-browser client (curl, a script). That is not this
  // threat: the attack needs a victim's browser, and browsers always send it.
  if (origin === undefined) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function hostAllowed(req) {
  const name = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

// ---------------------------------------------------------------------------
// Talking to the sandbox
// ---------------------------------------------------------------------------
async function sandboxFetch(pathname, init = {}) {
  return fetch(`${SANDBOX}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function sandboxJson(pathname, init) {
  const res = await sandboxFetch(pathname, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 400) || `HTTP ${res.status}` };
  }
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

/**
 * What an agent task is handed. Deliberately small: run a command, move a file
 * in or out. An agent gets no privileged back door the console itself lacks.
 */
function agentContext(sessionId, template) {
  return {
    sessionId,
    async exec(body, timeoutMs = 60000) {
      const result = await sandboxJson(`/exec/${encodeURIComponent(sessionId)}/execute`, {
        method: "POST",
        body: JSON.stringify({ template, timeout: timeoutMs, ...body }),
      });
      const pick = (stream) =>
        (result.output ?? []).filter((o) => o.stream === stream).map((o) => o.data).join("");
      return { exitCode: result.exitCode, stdout: pick("stdout"), stderr: pick("stderr"), raw: result };
    },
    write(filePath, content) {
      return sandboxJson(`/exec/${encodeURIComponent(sessionId)}/write`, {
        method: "POST",
        body: JSON.stringify({ path: filePath, content, template }),
      });
    },
    read(filePath, encoding = "utf8") {
      const qs = new URLSearchParams({ path: filePath, encoding });
      return sandboxJson(`/exec/${encodeURIComponent(sessionId)}/read?${qs}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
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

async function serveFile(absPath, root, res) {
  const abs = path.resolve(absPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(abs);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------
function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  return (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (!hostAllowed(req) || !originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end('{"error":"forbidden: unexpected Origin or Host"}');
  }

  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    // --- page and assets ---------------------------------------------------
    if (url.pathname === "/") return serveFile(path.join(HERE, "index.html"), HERE, res);
    if (url.pathname === "/app.js") return serveFile(path.join(HERE, "app.js"), HERE, res);
    if (url.pathname === "/styles.css") return serveFile(path.join(HERE, "styles.css"), HERE, res);
    if (url.pathname.startsWith("/novnc/")) {
      const rel = decodeURIComponent(url.pathname.slice("/novnc/".length));
      return serveFile(path.join(NOVNC, rel), NOVNC, res);
    }

    // --- sandbox pass-through ---------------------------------------------
    if (url.pathname === "/api/templates") return send(200, await sandboxJson("/exec/templates"));
    if (url.pathname === "/api/sessions") return send(200, await sandboxJson("/exec/"));

    if (url.pathname === "/api/tasks") return send(200, { tasks: listTasks() });

    const sessionRoute = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]+)\/(\w+)$/);
    if (sessionRoute) {
      const [, sessionId, action] = sessionRoute;

      if (action === "boot" && req.method === "POST") {
        const { template = "desktop" } = await readBody(req);
        const started = Date.now();
        const result = await sandboxJson(`/exec/${sessionId}/execute`, {
          method: "POST",
          body: JSON.stringify({ template, command: "sh", args: ["-c", "echo ready"] }),
        });
        return send(200, { ok: true, ms: Date.now() - started, exitCode: result.exitCode });
      }

      if (action === "destroy" && req.method === "DELETE") {
        return send(200, await sandboxJson(`/exec/${sessionId}`, { method: "DELETE" }));
      }

      if (action === "files") {
        const qs = new URLSearchParams({ path: url.searchParams.get("path") ?? "/workspace" });
        return send(200, await sandboxJson(`/exec/${sessionId}/files?${qs}`));
      }

      if (action === "read") {
        const qs = new URLSearchParams({
          path: url.searchParams.get("path") ?? "",
          encoding: url.searchParams.get("encoding") ?? "utf8",
        });
        return send(200, await sandboxJson(`/exec/${sessionId}/read?${qs}`));
      }

      if (action === "cancel" && req.method === "POST") {
        const { messageId } = await readBody(req);
        const r = await sandboxFetch(`/exec/${sessionId}/cancel`, {
          method: "POST",
          body: JSON.stringify({ messageId }),
        });
        return send(r.status, await r.json().catch(() => ({})));
      }

      // Streams the sandbox's NDJSON straight through as SSE, so output lands
      // in the browser as the guest produces it rather than at the end.
      if (action === "exec" && req.method === "POST") {
        const { command, args, template, messageId, timeout } = await readBody(req);
        const emit = openSse(res);
        const upstream = await sandboxFetch(`/exec/${sessionId}/execute?format=ndjson`, {
          method: "POST",
          body: JSON.stringify({ command, args, template, messageId, timeout }),
        });

        if (!upstream.ok || !upstream.body) {
          emit({ type: "error", error: `HTTP ${upstream.status}`, detail: await upstream.text() });
          return res.end();
        }

        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of upstream.body) {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              emit(JSON.parse(line));
            } catch {
              emit({ type: "raw", data: line });
            }
          }
        }
        if (buffered.trim()) {
          try { emit(JSON.parse(buffered)); } catch { emit({ type: "raw", data: buffered }); }
        }
        emit({ type: "end" });
        return res.end();
      }

      if (action === "agent" && req.method === "POST") {
        const { taskId } = await readBody(req);
        const task = getTask(taskId);
        if (!task) return send(404, { error: `unknown task: ${taskId}` });

        const emit = openSse(res);
        let closed = false;
        req.on("close", () => { closed = true; });

        await runTask(task, agentContext(sessionId, task.template), (event) => {
          if (!closed) emit(event);
        });
        emit({ type: "end" });
        return res.end();
      }
    }

    send(404, { error: "not found" });
  } catch (err) {
    if (!res.headersSent) send(err.status ?? 500, { error: err.message });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// VNC bridge: browser (no credentials) <-> sandbox (Bearer header)
// ---------------------------------------------------------------------------
// RFB is binary and already framed; src/routes/vnc.ts disables compression on
// the same bytes, and paying for it twice on one hop is worse than once.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/websockify") return socket.destroy();

  if (!hostAllowed(req) || !originAllowed(req)) {
    console.warn(`[bridge] refused: Origin=${req.headers.origin ?? "(none)"} Host=${req.headers.host ?? "(none)"}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }

  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const target = `${SANDBOX.replace(/^http/, "ws")}/exec/${encodeURIComponent(sessionId)}/vnc`;
    const upstream = new WebSocket(target, {
      headers: { Authorization: `Bearer ${KEY}` },
      perMessageDeflate: false,
    });

    // The socket handleUpgrade returns is already OPEN — a server-side ws socket
    // never emits `open`. It is `upstream` that opens late, so that is the only
    // direction that can need queueing.
    const pending = [];

    upstream.on("open", () => {
      console.log(`[bridge] ${sessionId}: connected`);
      while (pending.length) upstream.send(pending.shift(), { binary: true });
    });
    upstream.on("message", (d) => {
      if (client.readyState === WebSocket.OPEN) client.send(d, { binary: true });
    });
    client.on("message", (d) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: true });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(d);
    });

    const shutdown = (who) => (info) => {
      const detail = info instanceof Error ? info.message : `code=${info}`;
      console.log(`[bridge] ${sessionId}: ${who} closed (${detail})`);
      try { client.close(); } catch {}
      try { upstream.close(); } catch {}
    };
    upstream.on("close", shutdown("sandbox"));
    upstream.on("error", shutdown("sandbox"));
    client.on("close", shutdown("browser"));
    client.on("error", shutdown("browser"));

    upstream.on("unexpected-response", (_q, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.error(`[bridge] ${sessionId}: sandbox refused upgrade HTTP ${res.statusCode} ${body.slice(0, 200)}`);
        try { client.close(1011, `sandbox HTTP ${res.statusCode}`); } catch {}
      });
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-sandbox console  http://127.0.0.1:${PORT}  ->  ${SANDBOX}`);
  console.log("loopback only: reach it over an SSH tunnel.");
});
