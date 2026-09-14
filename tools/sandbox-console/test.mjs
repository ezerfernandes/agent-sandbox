/**
 * Tests for the console's proxy. Run with `npm test`.
 *
 * A stub stands in for the sandbox, so this needs no microVM, no API key and no
 * desktop template. What is under test is this tool's own behaviour: the Origin
 * and Host guards, that the API key is added on the browser's behalf and never
 * exposed to it, the NDJSON-to-SSE translation, and the agent loop's reporting.
 *
 * Not vitest: the console is a separate package from the server, whose suite
 * deliberately includes only `src/**`.
 */
import { createServer } from "http";
import { spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- stub sandbox ----------------------------------------------------------
const GREETING = "RFB 003.008\n";
const seen = { auth: [], execBodies: [], upstreamFrames: [] };

const stub = createServer((req, res) => {
  seen.auth.push(req.headers.authorization ?? null);

  if (req.headers.authorization !== "Bearer test-key") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end('{"error":"API key required"}');
  }

  const url = new URL(req.url, "http://x");

  if (url.pathname === "/exec/templates") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ templates: [{ name: "desktop" }] }));
  }
  if (url.pathname === "/exec/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ sessions: [{ sessionId: "s1", state: "active", template: "desktop" }] }));
  }

  // Streaming execute: emit NDJSON in pieces, so the SSE translation has to
  // handle a line split across two chunks.
  if (url.pathname.endsWith("/execute") && url.searchParams.get("format") === "ndjson") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.execBodies.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"type":"started","messageId":"m1"}\n');
      res.write('{"type":"stream","stream":"stdout","data":"hel');
      res.write('lo\\n"}\n{"type":"result","exitCode":0,"duration":12}\n');
      res.end();
    });
    return;
  }

  // Buffered execute, used by boot and by agent steps.
  if (url.pathname.endsWith("/execute")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.execBodies.push(parsed);
      const script = parsed.args?.[1] ?? "";
      let out = "ok\n";
      if (script.includes("uname")) out = "Linux 6.1.155\ninit\n";
      if (script.includes("free")) out = "Mem: 1488 44 1312\n";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exitCode: 0, duration: 5, output: [{ stream: "stdout", data: out }] }));
    });
    return;
  }

  if (url.pathname.endsWith("/read")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ content: "aGk=", size: 2, encoding: "base64" }));
  }
  if (url.pathname.endsWith("/files")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ files: [{ name: "shot.png", size: 40, type: "file" }] }));
  }

  res.writeHead(404).end("{}");
});

const stubWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
stub.on("upgrade", (req, socket, head) => {
  if (req.headers.authorization !== "Bearer test-key") {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  stubWss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(Buffer.from(GREETING), { binary: true });
    ws.on("message", (d) => seen.upstreamFrames.push(Buffer.from(d)));
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// --- console under test ----------------------------------------------------
const PORT = 6097;
const base = `http://127.0.0.1:${PORT}`;
const SELF = { Origin: base };

const proc = spawn(process.execPath, ["server.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, SANDBOX_KEY: "test-key", SANDBOX_URL: `http://127.0.0.1:${stubPort}`, CONSOLE_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

for (let i = 0; i < 60; i++) {
  try { await fetch(base, { headers: SELF }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

/** Collect every SSE event from a POST stream. */
async function collect(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...SELF, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text.split("\n\n")
    .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice(6)));
}

function ws(opts = {}) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/websockify?session=s1`, opts);
    const finish = (v) => { try { sock.terminate(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ result: "timeout" }), 5000);
    sock.on("message", (d) => { clearTimeout(timer); finish({ result: "data", data: Buffer.from(d) }); });
    sock.on("unexpected-response", (_q, r) => { clearTimeout(timer); finish({ result: "http", status: r.statusCode }); });
    sock.on("error", (e) => { clearTimeout(timer); finish({ result: "error", message: e.message }); });
  });
}

console.log("\nOrigin and Host guards");
{
  const r = await ws({ origin: "https://evil.example" });
  check("cross-origin WebSocket is refused", r.result === "http" && r.status === 403, `${r.result} ${r.status ?? ""}`);
}
{
  const r = await ws({ origin: base });
  check("the console's own page is bridged", r.result === "data" && r.data.toString() === GREETING, r.result);
}
{
  const r = await ws({ headers: { Host: "attacker.example" } });
  check("a rebound Host is refused", r.result === "http" && r.status === 403, `${r.result} ${r.status ?? ""}`);
}
{
  const res = await fetch(`${base}/api/sessions`, { headers: { Origin: "https://evil.example" } });
  check("cross-origin API read is refused", res.status === 403, String(res.status));
}
{
  const res = await fetch(`${base}/api/session/s1/boot`, {
    method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}",
  });
  check("cross-site POST cannot boot a VM", res.status === 403, String(res.status));
}

console.log("\nThe key stays on the server");
{
  const page = await (await fetch(base, { headers: SELF })).text();
  const app = await (await fetch(`${base}/app.js`, { headers: SELF })).text();
  check("no API key in the served page or script", !page.includes("test-key") && !app.includes("test-key"));
}
{
  // Drive one real upstream call first: the WebSocket tests above authenticate
  // in the stub's upgrade handler, which records nothing here.
  const res = await fetch(`${base}/api/sessions`, { headers: SELF });
  const body = await res.json();
  check("session list passes through", res.status === 200 && body.sessions?.[0]?.sessionId === "s1");
  check("the console supplied the key the browser never had",
    seen.auth.at(-1) === "Bearer test-key", String(seen.auth.at(-1)));
}

console.log("\nStreaming a command");
{
  const events = await collect("/api/session/s1/exec", { command: "sh", args: ["-c", "echo hello"] });
  check("NDJSON is translated to SSE", events.length >= 3, `${events.length} events`);
  check("a line split across chunks is reassembled",
    events.some((e) => e.type === "stream" && e.data === "hello\n"),
    JSON.stringify(events.filter((e) => e.type === "stream")));
  check("the result frame survives", events.some((e) => e.type === "result" && e.exitCode === 0));
  check("the stream is terminated", events.at(-1)?.type === "end");
}

console.log("\nThe agent loop");
{
  const events = await collect("/api/session/s1/agent", { taskId: "prove-isolation" });
  const starts = events.filter((e) => e.type === "step-start");
  const dones = events.filter((e) => e.type === "step-done");
  check("the task announces itself", events[0]?.type === "task-start");
  check("every step reports start and finish", starts.length === dones.length && starts.length >= 4,
    `${starts.length} starts, ${dones.length} dones`);
  check("steps carry guest output", dones.some((e) => (e.output ?? "").includes("Linux 6.1.155")));
  check("steps are timed", dones.every((e) => typeof e.ms === "number"));
  check("the task completes", events.some((e) => e.type === "task-done"));
}
{
  const events = await collect("/api/session/s1/agent", { taskId: "no-such-task" });
  check("an unknown task is rejected, not run", events.length === 0);
}

console.log("\nTask catalogue");
{
  const { tasks } = await (await fetch(`${base}/api/tasks`, { headers: SELF })).json();
  check("tasks are listed with their template", tasks.length >= 5 && tasks.every((t) => t.template && t.label));
  check("step titles are exposed without running anything", tasks.every((t) => Array.isArray(t.steps) && t.steps.length));
}

proc.kill("SIGTERM");
stub.close();
stubWss.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
