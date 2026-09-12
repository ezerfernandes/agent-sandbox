import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { STATUS_CODES, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import type { Socket } from "net";
import { authenticateRequest } from "../auth/middleware.js";
import { ensureSession } from "../session/gateway.js";
import { touchSession } from "../session/session.js";
import { openVsockPort } from "../vm/transport.js";
import { vncConnectionsActive, vncConnectionsTotal } from "../metrics.js";
import { logger } from "../logger.js";

/** Port the desktop template's socat bridge listens on inside the guest. */
const GUEST_VNC_PORT = 5900;
const VNC_PATH_REGEX = /^\/exec\/([A-Za-z0-9_-]+)\/vnc$/;
const TOUCH_INTERVAL_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
/** Same bound POST /exec/:id/execute applies to its `template` field. */
const MAX_TEMPLATE_NAME_LENGTH = 64;

/**
 * Map a session/VM provisioning failure to a status, matching what the REST
 * exec routes return for the same error — an unknown template is a 404 there,
 * and a caller debugging a 500 would have no idea which of the two it hit.
 */
function sessionErrorStatus(err: any): number {
  if (typeof err?.statusCode === "number") return err.statusCode;
  const message: string = err?.message ?? "";
  if (message.includes("belongs to another") || message.includes("Forbidden")) return 403;
  if (message.includes("not found") || message.includes("Unknown template")) return 404;
  return 500;
}

const wss = new WebSocketServer({
  noServer: true,
  // RFB is already a binary protocol with its own framing; compressing it costs
  // CPU per frame and buys nothing.
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
});

/** Live bridges, per session, so the per-session cap and shutdown can find them. */
const bridges = new Map<string, Set<() => void>>();

/**
 * Upgrades that have passed the cap check but have not yet become bridges.
 *
 * Without this the cap is a time-of-check/time-of-use hole: `countFor` runs
 * before two awaits (`ensureSession`, `openVsockPort`) and a connection only
 * joins `bridges` afterwards, so N simultaneous upgrades on one session all see
 * zero and all get through.
 */
const pendingUpgrades = new Map<string, number>();

function reserveSlot(sessionId: string): void {
  pendingUpgrades.set(sessionId, (pendingUpgrades.get(sessionId) ?? 0) + 1);
}

function releaseSlot(sessionId: string): void {
  const remaining = (pendingUpgrades.get(sessionId) ?? 1) - 1;
  if (remaining > 0) pendingUpgrades.set(sessionId, remaining);
  else pendingUpgrades.delete(sessionId);
}

function maxConnectionsPerSession(): number {
  const raw = Number(process.env.VNC_MAX_CONNECTIONS_PER_SESSION);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

function maxDurationMs(): number {
  const raw = Number(process.env.VNC_MAX_DURATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4 * 60 * 60 * 1000;
}

export function activeVncConnectionCount(): number {
  let total = 0;
  for (const set of bridges.values()) total += set.size;
  return total;
}

function countFor(sessionId: string): number {
  return (bridges.get(sessionId)?.size ?? 0) + (pendingUpgrades.get(sessionId) ?? 0);
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  result: string,
): void {
  vncConnectionsTotal.inc({ result });
  const body = JSON.stringify({ error: message });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

/**
 * Bridge an accepted WebSocket to an open guest socket, in both directions,
 * and tear both sides down exactly once whichever end dies first.
 */
function bridge(ws: WebSocket, guest: Socket, sessionId: string, rest: Buffer): void {
  const intervals: NodeJS.Timeout[] = [];
  let durationTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const teardown = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;

    for (const interval of intervals) clearInterval(interval);
    if (durationTimer) clearTimeout(durationTimer);
    guest.destroy();

    if (ws.readyState === ws.OPEN) {
      if (code) ws.close(code, reason);
      else ws.close();
    } else {
      ws.terminate();
    }

    const set = bridges.get(sessionId);
    if (set?.delete(teardownRef) && set.size === 0) bridges.delete(sessionId);
    vncConnectionsActive.dec();
  };

  const teardownRef = () => teardown(1001, "server shutting down");

  let set = bridges.get(sessionId);
  if (!set) {
    set = new Set();
    bridges.set(sessionId, set);
  }
  set.add(teardownRef);
  vncConnectionsActive.inc();
  vncConnectionsTotal.inc({ result: "success" });

  // Bytes that shared the segment with the handshake line are already part of
  // the RFB stream — the viewer never sees a greeting without them.
  if (rest.length > 0) ws.send(rest);

  // `end: false` on both pipes: an EOF on either side must reach `teardown`,
  // which closes the WebSocket with a status code. Letting the pipes end each
  // other closes it with no code at all (1005), and the viewer cannot tell a
  // crashed guest from a normal hang-up.
  const wsStream = createWebSocketStream(ws, { decodeStrings: false });
  wsStream.on("error", () => teardown(1011, "vnc stream error"));
  wsStream.pipe(guest, { end: false });
  guest.pipe(wsStream, { end: false });

  guest.on("close", () => teardown(1011, "guest closed the vnc connection"));
  guest.on("error", () => teardown(1011, "guest vnc connection error"));
  ws.on("close", () => teardown());
  ws.on("error", () => teardown());

  // The reaper only looks at lastActivityAt, and a watched desktop generates no
  // REST traffic at all — without this a 30-minute VNC session is destroyed
  // under the viewer.
  intervals.push(setInterval(() => touchSession(sessionId), TOUCH_INTERVAL_MS));

  // A browser tab that dies without closing the socket would otherwise pin the
  // VM's 1.5 GiB indefinitely.
  let awaitingPong = false;
  ws.on("pong", () => {
    awaitingPong = false;
  });
  intervals.push(
    setInterval(() => {
      if (awaitingPong) {
        logger.info({ sessionId }, "vnc peer failed to answer ping — dropping");
        teardown(1011, "ping timeout");
        return;
      }
      awaitingPong = true;
      try {
        ws.ping();
      } catch {
        teardown(1011, "ping failed");
      }
    }, PING_INTERVAL_MS),
  );

  const duration = maxDurationMs();
  durationTimer = setTimeout(() => {
    logger.info({ sessionId, durationMs: duration }, "vnc session hit max duration");
    teardown(1001, "max duration reached");
  }, duration);
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = VNC_PATH_REGEX.exec(url.pathname);
  if (!match) {
    rejectUpgrade(socket, 404, "Not found", "not_found");
    return;
  }

  const sessionId = match[1]!;

  const auth = authenticateRequest(req, ["exec"]);
  if (!auth.ok) {
    rejectUpgrade(socket, auth.status, auth.error, `auth_${auth.status}`);
    return;
  }

  if (countFor(sessionId) >= maxConnectionsPerSession()) {
    rejectUpgrade(
      socket,
      429,
      `Too many VNC connections for session ${sessionId}`,
      "rate_limited",
    );
    return;
  }

  const template = url.searchParams.get("template") ?? undefined;
  // Mirrors the validation POST /execute applies to the same field, so an
  // oversized value is a 400 here too rather than a 500 out of the generic
  // catch below.
  if (template !== undefined && template.length > MAX_TEMPLATE_NAME_LENGTH) {
    rejectUpgrade(
      socket,
      400,
      `template must be a string up to ${MAX_TEMPLATE_NAME_LENGTH} characters`,
      "bad_request",
    );
    return;
  }

  // From here on the slot is held, so every exit path must release it.
  reserveSlot(sessionId);
  let slotHeld = true;
  const releaseHeldSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    releaseSlot(sessionId);
  };

  let vsockPath: string;
  try {
    const vm = await ensureSession(sessionId, template, auth.key?.id);
    vsockPath = vm.vsock;
  } catch (err: any) {
    releaseHeldSlot();
    const status = sessionErrorStatus(err);
    logger.warn({ sessionId, err }, "vnc upgrade could not obtain a VM");
    rejectUpgrade(socket, status, err?.message ?? "Session error", `session_${status}`);
    return;
  }

  let guest: Socket;
  let rest: Buffer;
  try {
    ({ socket: guest, rest } = await openVsockPort(vsockPath, GUEST_VNC_PORT));
  } catch (err: any) {
    releaseHeldSlot();
    logger.warn({ sessionId, err }, "vnc upgrade could not reach the guest VNC port");
    rejectUpgrade(
      socket,
      502,
      "Guest VNC port unavailable — is this a desktop template?",
      "vsock_error",
    );
    return;
  }

  // The client may have vanished while the VM was booting.
  if (socket.destroyed) {
    releaseHeldSlot();
    guest.destroy();
    return;
  }

  // ws aborts the handshake itself — without calling this callback — on a bad
  // Sec-WebSocket-Key, an unsupported version, or a malformed extension header.
  // The guest socket is already open by then, so nothing would ever close it:
  // one leaked socket plus a live socat fork inside the guest, per request.
  let bridged = false;
  socket.once("close", () => {
    if (bridged) return;
    logger.warn({ sessionId }, "vnc upgrade aborted before handshake completed");
    vncConnectionsTotal.inc({ result: "upgrade_failed" });
    guest.destroy();
    releaseHeldSlot();
  });

  wss.handleUpgrade(req, socket, head, (ws) => {
    bridged = true;
    touchSession(sessionId);
    bridge(ws, guest, sessionId, rest);
    releaseHeldSlot();
  });
}

/**
 * Attach the VNC bridge to an HTTP server's upgrade event.
 *
 * Deliberately not part of `app`: keeping the Express app a plain app means the
 * supertest suites are unaffected by any of this.
 */
export function attachVncUpgrade(httpServer: Server): void {
  httpServer.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as Duplex, head).catch((err) => {
      logger.error({ err }, "vnc upgrade handler failed");
      try {
        rejectUpgrade(socket as Duplex, 500, "Internal error", "error");
      } catch {
        (socket as Duplex).destroy();
      }
    });
  });
}

export function closeAllVncConnections(): void {
  for (const set of [...bridges.values()]) {
    for (const teardown of [...set]) teardown();
  }
  bridges.clear();
}
