import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";

vi.mock("../session/gateway.js", () => ({
  ensureSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  cancelSessionMessage: vi.fn(),
}));

vi.mock("../session/session.js", () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
  getAllSessions: vi.fn(() => []),
  destroySession: vi.fn(),
  createSession: vi.fn(),
  startSessionReaper: vi.fn(),
}));

vi.mock("../auth/key-store.js", () => ({
  verifyKey: vi.fn(),
  touchKey: vi.fn(),
  flushKeys: vi.fn(),
}));

vi.mock("../auth/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(() => true),
}));

import {
  attachVncUpgrade,
  closeAllVncConnections,
  activeVncConnectionCount,
} from "./vnc.js";
import { ensureSession } from "../session/gateway.js";
import { touchSession } from "../session/session.js";
import { verifyKey } from "../auth/key-store.js";
import { register } from "../metrics.js";

const AUTH_HEADERS = { Authorization: "Bearer sk_test_key" };

let httpServer: http.Server;
let port: number;
let fakeVsock: net.Server | undefined;
let vsockPath: string;
let tmpRoot: string;
const openClients: WebSocket[] = [];

/** Fake Firecracker vsock multiplexer: answers CONNECT, then behaves as told. */
function startFakeVsock(
  behaviour: (socket: net.Socket, port: string) => void,
): Promise<void> {
  vsockPath = path.join(tmpRoot, `vsock-${Math.random().toString(36).slice(2)}.sock`);
  fakeVsock = net.createServer((socket) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      socket.removeListener("data", onData);
      behaviour(socket, line.replace("CONNECT ", ""));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  return new Promise((resolve) => fakeVsock!.listen(vsockPath, () => resolve()));
}

/** Messages can land in the same tick as `open`, so buffer from construction. */
const received = new WeakMap<WebSocket, Buffer[]>();

function connect(
  url = `ws://127.0.0.1:${port}/exec/sess-1/vnc`,
  options: WebSocket.ClientOptions = { headers: AUTH_HEADERS },
): WebSocket {
  const ws = new WebSocket(url, options);
  received.set(ws, []);
  ws.on("message", (data) => received.get(ws)!.push(data as Buffer));
  // Rejected upgrades and afterEach teardown both emit 'error'; without a
  // permanent listener those surface as unhandled exceptions.
  ws.on("error", () => {});
  openClients.push(ws);
  return ws;
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function nextMessage(ws: WebSocket, index = 0): Promise<Buffer> {
  await vi.waitFor(() => expect(received.get(ws)!.length).toBeGreaterThan(index));
  return received.get(ws)![index]!;
}

function onceClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function upgradeStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
  });
}

async function gaugeValue(): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const gauge = metrics.find((m) => m.name === "vnc_connections_active");
  return (gauge?.values?.[0]?.value as number) ?? 0;
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.AUTH_ENABLED;
  delete process.env.VNC_MAX_CONNECTIONS_PER_SESSION;
  delete process.env.VNC_MAX_DURATION_MS;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-test-"));

  vi.mocked(verifyKey).mockReturnValue({
    id: "key-1",
    name: "Test Key",
    scopes: ["exec"],
    rateLimit: 100,
  });

  httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachVncUpgrade(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as net.AddressInfo).port;
});

afterEach(async () => {
  closeAllVncConnections();
  for (const ws of openClients.splice(0)) ws.terminate();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  if (fakeVsock) {
    await new Promise<void>((resolve) => fakeVsock!.close(() => resolve()));
    fakeVsock = undefined;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mockVmOnFakeVsock() {
  vi.mocked(ensureSession).mockResolvedValue({
    id: "vm-1",
    state: "ready",
    vsock: vsockPath,
  } as any);
}

describe("GET /exec/:sessionId/vnc (WebSocket)", () => {
  it("forwards bytes that arrived with the OK line and never leaks the OK line itself", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\nRFB 003.008\n"));
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);
    const first = await nextMessage(ws);

    expect(first.toString()).toBe("RFB 003.008\n");
    expect(first.toString()).not.toContain("OK 5900");
  });

  it("pipes traffic in both directions", async () => {
    await startFakeVsock((socket) => {
      socket.write("OK 5900\n");
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);
    ws.send(Buffer.from("rfb-client-bytes"));

    expect((await nextMessage(ws)).toString()).toBe("echo:rfb-client-bytes");
  });

  it("asks for the guest VNC port and keeps the session alive against the reaper", async () => {
    let requestedPort = "";
    await startFakeVsock((socket, p) => {
      requestedPort = p;
      socket.write("OK 5900\n");
    });
    mockVmOnFakeVsock();

    const ws = connect(`ws://127.0.0.1:${port}/exec/sess-1/vnc?template=desktop`);
    await onceOpen(ws);

    expect(requestedPort).toBe("5900");
    expect(ensureSession).toHaveBeenCalledWith("sess-1", "desktop", "key-1");
    expect(touchSession).toHaveBeenCalledWith("sess-1");
  });

  it("closes the WebSocket with 1011 when the guest hangs up", async () => {
    await startFakeVsock((socket) => {
      socket.write("OK 5900\n");
      setTimeout(() => socket.destroy(), 20);
    });
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);

    const { code } = await onceClose(ws);
    expect(code).toBe(1011);
  });

  it("rejects an unauthenticated upgrade with 401", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect(`ws://127.0.0.1:${port}/exec/sess-1/vnc`, {});

    expect(await upgradeStatus(ws)).toBe(401);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("rejects a key without the exec scope with 403", async () => {
    vi.mocked(verifyKey).mockReturnValue({
      id: "key-metrics",
      name: "Metrics Only",
      scopes: ["metrics"],
      rateLimit: 100,
    });
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect();

    expect(await upgradeStatus(ws)).toBe(403);
  });

  it("returns 404 for a path that is not a vnc endpoint", async () => {
    const ws = connect(`ws://127.0.0.1:${port}/exec/sess-1/not-vnc`);

    expect(await upgradeStatus(ws)).toBe(404);
  });

  it("caps concurrent connections per session with 429", async () => {
    process.env.VNC_MAX_CONNECTIONS_PER_SESSION = "1";
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const first = connect();
    await onceOpen(first);

    const second = connect();
    expect(await upgradeStatus(second)).toBe(429);
  });

  it("returns 502 when the guest refuses the VNC port", async () => {
    await startFakeVsock((socket) => socket.write("ERR no listener\n"));
    mockVmOnFakeVsock();

    const ws = connect();

    expect(await upgradeStatus(ws)).toBe(502);
  });

  it("maps an ownership failure from ensureSession to its status code", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    const err: any = new Error("Session belongs to another owner");
    err.statusCode = 403;
    vi.mocked(ensureSession).mockRejectedValue(err);

    const ws = connect();

    expect(await upgradeStatus(ws)).toBe(403);
  });

  it("returns the active-connection gauge to zero after a client disconnects", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);
    expect(await gaugeValue()).toBe(1);
    expect(activeVncConnectionCount()).toBe(1);

    const closed = onceClose(ws);
    ws.close();
    await closed;
    await vi.waitFor(async () => expect(await gaugeValue()).toBe(0));
    expect(activeVncConnectionCount()).toBe(0);
  });

  it("drops the connection once VNC_MAX_DURATION_MS elapses", async () => {
    process.env.VNC_MAX_DURATION_MS = "120";
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);

    const { code } = await onceClose(ws);
    expect(code).toBe(1001);
  });

  it("closes every live connection on shutdown", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect();
    await onceOpen(ws);

    const closed = onceClose(ws);
    closeAllVncConnections();
    await closed;

    expect(activeVncConnectionCount()).toBe(0);
    expect(await gaugeValue()).toBe(0);
  });

  it("destroys the guest socket when ws aborts the handshake (F3)", async () => {
    let guestClosed: Promise<void> | undefined;
    await startFakeVsock((socket) => {
      guestClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write("OK 5900\n");
    });
    mockVmOnFakeVsock();

    // A WebSocket version ws rejects: it aborts the handshake itself and never
    // calls the upgrade callback, so nothing in the happy path can clean up.
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        port,
        path: "/exec/sess-1/vnc",
        headers: {
          ...AUTH_HEADERS,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
          "Sec-WebSocket-Version": "7",
        },
      });
      req.on("response", (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      req.on("upgrade", () => reject(new Error("handshake unexpectedly succeeded")));
      req.on("error", reject);
      req.end();
    });

    expect(res).toBe(400);
    // Without the fix this never resolves: the socket and its guest-side socat
    // fork stay open for the life of the process.
    await expect(guestClosed).resolves.toBeUndefined();
    await vi.waitFor(() => expect(activeVncConnectionCount()).toBe(0));
  });

  it("frees the reserved slot after a failed upgrade, so the cap is not poisoned (F3/F4)", async () => {
    process.env.VNC_MAX_CONNECTIONS_PER_SESSION = "1";
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    await new Promise<void>((resolve) => {
      const req = http.request({
        port,
        path: "/exec/sess-1/vnc",
        headers: {
          ...AUTH_HEADERS,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
          "Sec-WebSocket-Version": "7",
        },
      });
      req.on("response", (r) => { r.resume(); resolve(); });
      req.on("error", () => resolve());
      req.end();
    });

    // The slot the aborted upgrade reserved must be back, or this session can
    // never be watched again.
    const ws = connect();
    await onceOpen(ws);
    expect(activeVncConnectionCount()).toBe(1);
  });

  it("counts in-flight upgrades against the per-session cap (F4)", async () => {
    process.env.VNC_MAX_CONNECTIONS_PER_SESSION = "1";
    // Delay the VM so both upgrades are inside the window between the cap check
    // and joining `bridges` — the race the old check-then-act version lost.
    vi.mocked(ensureSession).mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ id: "vm-1", state: "ready", vsock: vsockPath } as any), 60),
        ),
    );
    await startFakeVsock((socket) => socket.write("OK 5900\n"));

    const first = connect();
    const second = connect();
    const results = await Promise.allSettled([
      onceOpen(first),
      upgradeStatus(second).catch(() => onceOpen(second).then(() => 101)),
    ]);

    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"));
    // Exactly one connection may live; the other must be turned away.
    expect(statuses).toContain(429);
    await vi.waitFor(() => expect(activeVncConnectionCount()).toBe(1));
  });

  it("rejects an oversized template parameter with 400 (F5)", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect(
      `ws://127.0.0.1:${port}/exec/sess-1/vnc?template=${"x".repeat(65)}`,
    );

    expect(await upgradeStatus(ws)).toBe(400);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("maps an unknown template to 404, as the REST exec routes do (F5)", async () => {
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    vi.mocked(ensureSession).mockRejectedValue(
      new Error('Unknown template "desktop". Available: node'),
    );

    const ws = connect(`ws://127.0.0.1:${port}/exec/sess-1/vnc?template=desktop`);

    expect(await upgradeStatus(ws)).toBe(404);
  });

  it("honours AUTH_ENABLED=false", async () => {
    process.env.AUTH_ENABLED = "false";
    await startFakeVsock((socket) => socket.write("OK 5900\n"));
    mockVmOnFakeVsock();

    const ws = connect(`ws://127.0.0.1:${port}/exec/sess-1/vnc`, {});
    await onceOpen(ws);

    expect(ensureSession).toHaveBeenCalledWith("sess-1", undefined, undefined);
    expect(verifyKey).not.toHaveBeenCalled();
  });
});
