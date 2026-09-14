/**
 * Desktop-control adapter for agent-sandbox.
 *
 * Terminates the seven gesture routes of the Box Desktop Control schema —
 * /screenshot, /mouse/*, /keyboard/*, /wait — and translates each into a single
 * call to the sandbox's /exec API against a desktop session.
 *
 * It lives beside the sandbox rather than inside it on purpose. The sandbox's
 * REST surface is session-scoped and command-oriented; this schema is stateless
 * and gesture-oriented. Merging them would give one service two incompatible
 * ideas of what a session is.
 *
 *   SANDBOX_KEY=sk_... DESKTOP_SESSION=desk-1 node server.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  BadRequest,
  mouseMove,
  mouseClick,
  mouseScroll,
  keyboardType,
  keyboardKey,
  waitMs,
  screenshotCommand,
  SHOT_PNG,
  SHOT_WEBP,
} from "./translate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.ADAPTER_PORT ?? 6100);
const SANDBOX = process.env.SANDBOX_URL ?? "http://127.0.0.1:3000";
const KEY = process.env.SANDBOX_KEY;
const DEFAULT_SESSION = process.env.DESKTOP_SESSION ?? "desk-1";
const TEMPLATE = process.env.DESKTOP_TEMPLATE ?? "desktop";
const PIXELS_PER_NOTCH = Number(process.env.SCROLL_PIXELS_PER_NOTCH ?? 100);
const TYPE_DELAY_MS = Number(process.env.TYPE_DELAY_MS ?? 12);
const BIND = process.env.ADAPTER_BIND ?? "127.0.0.1";
const AUTOCREATE = process.env.ADAPTER_AUTOCREATE === "true";

if (!KEY) {
  console.error("SANDBOX_KEY is required (an API key with the exec scope).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sandbox client
// ---------------------------------------------------------------------------
async function sandboxJson(pathname, init = {}) {
  const res = await fetch(`${SANDBOX}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) || `HTTP ${res.status}` }; }
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

/**
 * Run one command in the session.
 *
 * The sandbox answers 200 for a command that ran and failed — the failure is in
 * `exitCode`, not the status. A gesture route that ignored that would report a
 * click as delivered when xdotool could not reach the display, so a nonzero
 * exit is raised here.
 */
async function runInGuest(sessionId, { command, args }, timeout = 30_000) {
  const result = await sandboxJson(`/exec/${encodeURIComponent(sessionId)}/execute`, {
    method: "POST",
    body: JSON.stringify({ template: TEMPLATE, command, args, timeout }),
  });

  const stream = (which) => (result.output ?? []).filter((o) => o.stream === which).map((o) => o.data).join("");
  const stdout = stream("stdout");
  const stderr = stream("stderr");

  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`guest command failed (exit ${result.exitCode}): ${(stderr || stdout).trim().slice(0, 300)}`), {
      status: 502,
    });
  }
  return { stdout, stderr, durationMs: result.duration };
}

function readFromGuest(sessionId, filePath, encoding) {
  const qs = new URLSearchParams({ path: filePath, encoding });
  return sandboxJson(`/exec/${encodeURIComponent(sessionId)}/read?${qs}`);
}

// ---------------------------------------------------------------------------
// Per-session facts, discovered once
// ---------------------------------------------------------------------------
// Geometry and webp support are properties of the guest, not of this process.
// Cached per session so every gesture does not pay for two extra round trips,
// and dropped when a session is recreated at a different size.
const sessionFacts = new Map();

/**
 * The sandbox provisions a session lazily: any request naming an id it has not
 * seen boots a microVM for it. That is right for /exec, and wrong here — a
 * typo in a session id would quietly cost a 1.5 GiB desktop VM, and the gesture
 * would report 204 for a screen nobody is looking at. So an unknown session is
 * refused unless the operator has asked for the other behaviour.
 */
async function assertSessionExists(sessionId) {
  if (AUTOCREATE) return;
  const { sessions = [] } = await sandboxJson("/exec/");
  if (!sessions.some((s) => s.sessionId === sessionId)) {
    throw Object.assign(
      new Error(
        `session "${sessionId}" does not exist. Boot it first, or start the adapter with ADAPTER_AUTOCREATE=true to provision on demand.`,
      ),
      { status: 404 },
    );
  }
}

async function factsFor(sessionId) {
  const cached = sessionFacts.get(sessionId);
  if (cached) return cached;

  await assertSessionExists(sessionId);

  const { stdout } = await runInGuest(sessionId, {
    command: "sh",
    args: ["-c", "xdotool getdisplaygeometry; command -v cwebp >/dev/null && echo webp || echo nowebp"],
  });

  const [dims = "", webpLine = ""] = stdout.trim().split("\n");
  const [width, height] = dims.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw Object.assign(new Error(`could not read display geometry from the guest: ${JSON.stringify(stdout)}`), { status: 502 });
  }

  const facts = { geometry: { width, height }, webp: webpLine.trim() === "webp" };
  sessionFacts.set(sessionId, facts);
  console.log(`[adapter] ${sessionId}: ${width}x${height}, webp ${facts.webp ? "available" : "unavailable (serving PNG)"}`);
  return facts;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BadRequest("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("request body must be JSON");
  }
}

/**
 * The schema is stateless and names no session, but every sandbox call needs
 * one. Resolved in order of explicitness so the schema's literal paths keep
 * working while multi-session callers are still served:
 *   /desktop/:sessionId/mouse/click  >  X-Sandbox-Session header  >  default
 */
function resolveSession(url, req) {
  const prefixed = url.pathname.match(/^\/desktop\/([A-Za-z0-9_-]{1,64})(\/.*)$/);
  if (prefixed) return { sessionId: prefixed[1], route: prefixed[2] };

  const header = req.headers["x-sandbox-session"];
  if (typeof header === "string" && header.trim()) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(header.trim())) throw new BadRequest("X-Sandbox-Session is not a valid session id");
    return { sessionId: header.trim(), route: url.pathname };
  }

  return { sessionId: DEFAULT_SESSION, route: url.pathname };
}

const GESTURES = {
  "/mouse/move": mouseMove,
  "/mouse/click": mouseClick,
  "/mouse/scroll": (body, geometry) => mouseScroll(body, geometry, PIXELS_PER_NOTCH),
  "/keyboard/type": (body, geometry) => keyboardType(body, geometry, TYPE_DELAY_MS),
  "/keyboard/key": (body) => keyboardKey(body),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname === "/healthz") return send(200, { ok: true, sandbox: SANDBOX, defaultSession: DEFAULT_SESSION });

    if (url.pathname === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(await readFile(path.join(HERE, "openapi.json")));
    }

    const { sessionId, route } = resolveSession(url, req);

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      return res.end('{"error":"method not allowed"}');
    }

    // --- /wait: served here, not in the guest --------------------------------
    // Waiting for the UI to settle is a client-side pause. Sending it to the
    // guest would hold that session's command lock for the duration, blocking
    // the very screenshot the caller is waiting to take.
    if (route === "/wait") {
      const { ms } = waitMs(await readBody(req));
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      return res.writeHead(204).end();
    }

    // --- /screenshot ---------------------------------------------------------
    if (route === "/screenshot") {
      const { webp } = await factsFor(sessionId);
      const accept = String(req.headers.accept ?? "");
      const wantsPng = accept.includes("image/png") && !accept.includes("image/webp");
      const useWebp = webp && !wantsPng;

      await runInGuest(sessionId, screenshotCommand({ webp: useWebp }), 60_000);
      const file = await readFromGuest(sessionId, useWebp ? SHOT_WEBP : SHOT_PNG, "base64");
      const bytes = Buffer.from(file.content, "base64");

      res.writeHead(200, {
        "Content-Type": useWebp ? "image/webp" : "image/png",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        // Say plainly when the guest could not produce the schema's format,
        // rather than letting a caller infer it from the bytes.
        ...(useWebp ? {} : { "X-Adapter-Format-Note": "guest has no webp encoder; PNG returned" }),
      });
      return res.end(bytes);
    }

    // --- gestures ------------------------------------------------------------
    const translate = GESTURES[route];
    if (!translate) return send(404, { error: `no such operation: ${route}` });

    const { geometry } = await factsFor(sessionId);
    const body = await readBody(req);
    const { command, args } = translate(body, geometry);

    await runInGuest(sessionId, { command, args });
    return res.writeHead(204).end();
  } catch (err) {
    const status = err.status ?? 500;
    // A session recreated at a new size must not keep the old geometry.
    if (status === 404 || status === 502) sessionFacts.delete(resolveSession(url, req).sessionId);
    if (!res.headersSent) send(status, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, BIND, () => {
  console.log(`desktop-control adapter  http://${BIND}:${PORT}  ->  ${SANDBOX}`);
  console.log(`default session: ${DEFAULT_SESSION}   (override per request with X-Sandbox-Session, or /desktop/<id>/...)`);
});
