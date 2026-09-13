/**
 * Tests for the viewer bridge. Run with `npm test`.
 *
 * A stub stands in for the sandbox, so this needs no microVM, no API key and no
 * desktop template — it exercises the parts that are this tool's own: the
 * Origin and Host checks, and that bytes survive the hop in both directions.
 *
 * These are not vitest: the viewer is a separate package from the server, and
 * the root suite's `include` is `src/**` on purpose.
 */
import { createServer } from "http";
import { spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { once } from "events";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- stub sandbox ----------------------------------------------------------
// Answers /exec/:id/vnc with an RFB greeting, but only when the request carries
// the Bearer header — so a test that gets RFB back has proved the viewer added
// credentials the browser never had.
const GREETING = "RFB 003.008\n";
const seenUpstream = [];

const stub = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
const stubWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

stub.on("upgrade", (req, socket, head) => {
  if (req.headers.authorization !== "Bearer test-key") {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  stubWss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(Buffer.from(GREETING), { binary: true });
    ws.on("message", (d) => {
      seenUpstream.push(Buffer.from(d));
      ws.send(Buffer.from([0x01, 0x01]), { binary: true }); // echo something back
    });
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// --- viewer under test -----------------------------------------------------
const viewerPort = 6099;
const viewer = spawn(process.execPath, ["server.mjs"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    SANDBOX_KEY: "test-key",
    SANDBOX_URL: `http://127.0.0.1:${stubPort}`,
    VIEWER_PORT: String(viewerPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
viewer.stdout.on("data", () => {});
viewer.stderr.on("data", () => {});

const base = `http://127.0.0.1:${viewerPort}`;
for (let i = 0; i < 60; i++) {
  try {
    await fetch(base, { headers: { Host: `127.0.0.1:${viewerPort}` } });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Open a websocket to the viewer and report how it was answered. */
function connect(opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${viewerPort}/websockify?session=s1`, opts);
    const finish = (v) => { try { ws.terminate(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ result: "timeout" }), 5000);
    ws.on("message", (d) => { clearTimeout(timer); finish({ result: "data", data: Buffer.from(d) }); });
    ws.on("unexpected-response", (_q, res) => { clearTimeout(timer); finish({ result: "http", status: res.statusCode }); });
    ws.on("error", (e) => { clearTimeout(timer); finish({ result: "error", message: e.message }); });
  });
}

console.log("\nOrigin / Host enforcement on the WebSocket bridge");

{
  const r = await connect({ origin: "https://evil.example" });
  check("a cross-origin page is refused", r.result === "http" && r.status === 403,
    `got ${r.result} ${r.status ?? r.message ?? ""}`);
}
{
  const r = await connect({ origin: `http://127.0.0.1:${viewerPort}` });
  check("the viewer's own page is allowed", r.result === "data" && r.data.toString() === GREETING,
    `got ${r.result} ${r.data?.toString?.() ?? ""}`);
}
{
  const r = await connect({ origin: `http://localhost:${viewerPort}` });
  check("localhost spelling is allowed", r.result === "data", `got ${r.result}`);
}
{
  // No Origin header at all: a non-browser client, not the cross-site threat.
  const r = await connect();
  check("a non-browser client (no Origin) still works", r.result === "data", `got ${r.result}`);
}
{
  const r = await connect({ headers: { Host: "attacker.example" } });
  check("a rebound DNS name (bad Host) is refused", r.result === "http" && r.status === 403,
    `got ${r.result} ${r.status ?? ""}`);
}

console.log("\nOrigin / Host enforcement on the HTTP API");

{
  const res = await fetch(`${base}/api/sessions`, { headers: { Origin: "https://evil.example" } });
  check("cross-origin GET /api/sessions is refused", res.status === 403, `got ${res.status}`);
}
{
  const res = await fetch(`${base}/api/start?session=s1`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  check("cross-site POST /api/start is refused", res.status === 403, `got ${res.status}`);
}
{
  const res = await fetch(`${base}/api/sessions`, { headers: { Origin: `http://127.0.0.1:${viewerPort}` } });
  check("same-origin GET /api/sessions is allowed", res.status === 200, `got ${res.status}`);
}

console.log("\nThe bridge itself");

{
  const ws = new WebSocket(`ws://127.0.0.1:${viewerPort}/websockify?session=s1`, {
    origin: `http://127.0.0.1:${viewerPort}`,
  });
  const frames = [];
  ws.on("message", (d) => frames.push(Buffer.from(d)));
  await once(ws, "open");
  await new Promise((r) => setTimeout(r, 200));
  check("the sandbox greeting reaches the browser", frames[0]?.toString() === GREETING,
    JSON.stringify(frames[0]?.toString()));

  const payload = Buffer.from([0x52, 0x46, 0x42, 0x00, 0xff, 0xfe]);
  ws.send(payload, { binary: true });
  await new Promise((r) => setTimeout(r, 300));
  check("browser bytes reach the sandbox unchanged",
    seenUpstream.some((b) => b.equals(payload)),
    seenUpstream.map((b) => b.toString("hex")).join(","));
  check("sandbox bytes flow back after the first frame",
    frames.some((b) => b.equals(Buffer.from([0x01, 0x01]))),
    frames.map((b) => b.toString("hex")).join(","));

  // The viewer holds the key; this socket never sent one. The stub 401s any
  // upstream dial without it, so receiving RFB at all proves it was added.
  check("the viewer supplied credentials the client never had", frames.length > 0);
  ws.terminate();
}

{
  // A refused upgrade must not leave the client hanging.
  const before = Date.now();
  const r = await connect({ origin: "https://evil.example" });
  check("refusal is immediate, not a hang", r.result === "http" && Date.now() - before < 2000);
}

viewer.kill("SIGTERM");
stub.close();
stubWss.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
