/**
 * Tests for the desktop-control adapter. Run with `npm test`.
 *
 * Two layers, and the split is the point:
 *   - the translation layer is pure, so its cases need no server at all;
 *   - the HTTP layer runs against a stub sandbox that records the argv it is
 *     asked to execute, so a route is checked by what it would do to a guest
 *     rather than by whether it answered 204.
 *
 * No microVM, no key, no desktop template.
 */
import { createServer } from "http";
import { spawn } from "child_process";
import {
  BadRequest, mouseMove, mouseClick, mouseScroll, keyboardType, keyboardKey, waitMs,
} from "./translate.mjs";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const throws = (fn, name) => {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, e instanceof BadRequest, `threw ${e.constructor.name}: ${e.message}`); }
};
const G = { width: 1280, height: 800 };
const argvOf = (r) => r.args.join(" ");

console.log("\nTranslation — pointer");
check("move becomes an absolute mousemove", argvOf(mouseMove({ x: 640, y: 400 }, G)) === "mousemove 640 400");
check("a plain click moves first, then clicks button 1",
  argvOf(mouseClick({ x: 10, y: 20 }, G)) === "mousemove 10 20 click 1");
check("right maps to X button 3, not 2",
  argvOf(mouseClick({ x: 1, y: 1, button: "right" }, G)) === "mousemove 1 1 click 3");
check("middle maps to X button 2",
  argvOf(mouseClick({ x: 1, y: 1, button: "middle" }, G)) === "mousemove 1 1 click 2");
check("press-and-hold chains down, sleep and up in one invocation",
  argvOf(mouseClick({ x: 5, y: 6, holdDurationMs: 750 }, G)) === "mousemove 5 6 mousedown 1 sleep 0.750 mouseup 1");
check("a zero hold is an ordinary click, not a 0s sleep",
  argvOf(mouseClick({ x: 5, y: 6, holdDurationMs: 0 }, G)) === "mousemove 5 6 click 1");

console.log("\nTranslation — coordinate bounds come from the display, not the schema");
throws(() => mouseMove({ x: 1280, y: 0 }, G), "x at the width is rejected (it is exclusive)");
throws(() => mouseMove({ x: 0, y: 800 }, G), "y at the height is rejected");
throws(() => mouseMove({ x: -1, y: 0 }, G), "a negative coordinate is rejected");
throws(() => mouseMove({ x: 1.5, y: 0 }, G), "a fractional coordinate is rejected");
throws(() => mouseMove({ y: 0 }, G), "a missing coordinate is rejected");
throws(() => mouseMove({ x: "640", y: 400 }, G), "a stringified number is rejected");
check("a larger display accepts what 1280x800 would not",
  argvOf(mouseMove({ x: 1600, y: 1000 }, { width: 1920, height: 1080 })) === "mousemove 1600 1000");

console.log("\nTranslation — scroll, which is lossy by nature");
check("positive deltaY scrolls down (button 5)",
  argvOf(mouseScroll({ x: 0, y: 0, deltaY: 300 }, G)) === "mousemove 0 0 click --repeat 3 5");
check("negative deltaY scrolls up (button 4)",
  argvOf(mouseScroll({ x: 0, y: 0, deltaY: -300 }, G)) === "mousemove 0 0 click --repeat 3 4");
check("a sub-notch delta still scrolls one notch rather than nothing",
  argvOf(mouseScroll({ x: 0, y: 0, deltaY: 7 }, G)) === "mousemove 0 0 click --repeat 1 5");
check("horizontal scroll uses buttons 6 and 7",
  argvOf(mouseScroll({ x: 0, y: 0, deltaX: 200 }, G)) === "mousemove 0 0 click --repeat 2 7");
check("both axes are emitted in one invocation",
  argvOf(mouseScroll({ x: 0, y: 0, deltaY: 100, deltaX: -100 }, G)) === "mousemove 0 0 click --repeat 1 5 click --repeat 1 6");
check("notch size is configurable",
  argvOf(mouseScroll({ x: 0, y: 0, deltaY: 300 }, G, 50)) === "mousemove 0 0 click --repeat 6 5");
check("the lossy conversion is reported back",
  /300px vertical -> 3 notch/.test(mouseScroll({ x: 0, y: 0, deltaY: 300 }, G).note ?? ""));
throws(() => mouseScroll({ x: 0, y: 0, deltaY: 0 }, G), "a scroll with no movement is rejected");

console.log("\nTranslation — keyboard");
check("text is one argv element after --",
  JSON.stringify(keyboardType({ text: "hello world" }, G).args) === '["type","--delay","12","--","hello world"]');
check("shell metacharacters are carried verbatim, not escaped away",
  keyboardType({ text: "; rm -rf / && $(id) `whoami` | nc x 1" }, G).args.at(-1) === "; rm -rf / && $(id) `whoami` | nc x 1");
check("a leading dash cannot be read as an option",
  keyboardType({ text: "--window 1" }, G).args.at(-2) === "--");
check("newlines and quotes survive",
  keyboardType({ text: 'a\n"b"\t\\c' }, G).args.at(-1) === 'a\n"b"\t\\c');
throws(() => keyboardType({ text: "" }, G), "empty text is rejected");
throws(() => keyboardType({ text: 42 }, G), "non-string text is rejected");
throws(() => keyboardType({ text: "x".repeat(4097) }, G), "over-long text is rejected");

check("a bare key becomes a keysym", argvOf(keyboardKey({ key: "Enter" })) === "key Enter");
check("modifiers precede the key", argvOf(keyboardKey({ key: "a", modifiers: ["ctrl"] })) === "key ctrl+a");
check("several modifiers keep their order",
  argvOf(keyboardKey({ key: "Tab", modifiers: ["ctrl", "shift"] })) === "key ctrl+shift+Tab");
check("meta is sent as X's super", argvOf(keyboardKey({ key: "d", modifiers: ["meta"] })) === "key super+d");
check("underscore keysyms are accepted", argvOf(keyboardKey({ key: "Page_Down" })) === "key Page_Down");
throws(() => keyboardKey({ key: "ctrl+c" }), "a chord smuggled into `key` is rejected");
throws(() => keyboardKey({ key: "a b" }), "a key with a space is rejected");
throws(() => keyboardKey({ key: "Enter", modifiers: ["hyper"] }), "an unknown modifier is rejected");
throws(() => keyboardKey({ key: "Enter", modifiers: "ctrl" }), "a non-array modifiers is rejected");

console.log("\nTranslation — wait");
check("ms passes through", waitMs({ ms: 250 }).ms === 250);
check("an absent body waits zero", waitMs({}).ms === 0);
throws(() => waitMs({ ms: 30001 }), "a wait beyond the cap is rejected");
throws(() => waitMs({ ms: -1 }), "a negative wait is rejected");

// ---------------------------------------------------------------------------
// HTTP layer, against a stub sandbox
// ---------------------------------------------------------------------------
const executed = [];
let webpAvailable = false;

const stub = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer test-key") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end('{"error":"API key required"}');
  }
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/exec/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      sessions: [
        { sessionId: "desk-default", state: "active", template: "desktop" },
        { sessionId: "other-session", state: "active", template: "desktop" },
        { sessionId: "path-session", state: "active", template: "desktop" },
      ],
    }));
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};

    if (url.pathname.endsWith("/execute")) {
      executed.push(parsed);
      const script = parsed.args?.join(" ") ?? "";
      let stdout = "";
      if (script.includes("getdisplaygeometry")) {
        stdout = `1280 800\n${webpAvailable ? "webp" : "nowebp"}\n`;
      }
      if (script.includes("getdisplaygeometry") && parsed.__fail) stdout = "";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        exitCode: parsed.args?.includes("__boom") ? 1 : 0,
        duration: 4,
        output: stdout ? [{ stream: "stdout", data: stdout }] : [{ stream: "stderr", data: parsed.args?.includes("__boom") ? "Cannot open display\n" : "" }],
      }));
    }

    if (url.pathname.endsWith("/read")) {
      // A 1x1 PNG, so a caller checking magic bytes gets a real answer.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        size: 70,
        encoding: "base64",
      }));
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));

const PORT = 6101;
const base = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, ["server.mjs"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    SANDBOX_KEY: "test-key",
    SANDBOX_URL: `http://127.0.0.1:${stub.address().port}`,
    ADAPTER_PORT: String(PORT),
    DESKTOP_SESSION: "desk-default",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

for (let i = 0; i < 60; i++) {
  try { await fetch(`${base}/healthz`, { method: "POST" }); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const lastGesture = () => executed.filter((e) => e.command === "xdotool").at(-1);

console.log("\nHTTP — the seven operations");
{
  const res = await post("/mouse/move", { x: 100, y: 200 });
  check("move answers 204 with no body", res.status === 204 && (await res.text()) === "");
  check("move reached the guest as argv", lastGesture()?.args.join(" ") === "mousemove 100 200");
  check("the command was never wrapped in a shell", lastGesture()?.command === "xdotool");
}
{
  await post("/mouse/click", { x: 1, y: 2, button: "right", holdDurationMs: 500 });
  check("click carries button and hold through to the guest",
    lastGesture()?.args.join(" ") === "mousemove 1 2 mousedown 3 sleep 0.500 mouseup 3");
}
{
  await post("/mouse/scroll", { x: 3, y: 4, deltaY: -250 });
  check("scroll reached the guest as notches", lastGesture()?.args.join(" ") === "mousemove 3 4 click --repeat 3 4");
}
{
  await post("/keyboard/type", { text: "$(id); rm -rf /" });
  check("hostile text arrives at the guest unexecuted and unescaped",
    lastGesture()?.args.at(-1) === "$(id); rm -rf /" && lastGesture()?.command === "xdotool");
}
{
  await post("/keyboard/key", { key: "Tab", modifiers: ["ctrl", "shift"] });
  check("chord reached the guest", lastGesture()?.args.join(" ") === "key ctrl+shift+Tab");
}
{
  const before = Date.now();
  const res = await post("/wait", { ms: 300 });
  const elapsed = Date.now() - before;
  const guestCalls = executed.length;
  await new Promise((r) => setTimeout(r, 50));
  check("wait answers 204 after actually waiting", res.status === 204 && elapsed >= 290, `${elapsed}ms`);
  check("wait never touches the guest", executed.length === guestCalls);
}
{
  const res = await post("/screenshot");
  const buf = Buffer.from(await res.arrayBuffer());
  check("screenshot returns binary, not JSON", res.status === 200 && buf.subarray(1, 4).toString() === "PNG");
  check("PNG is labelled as PNG", res.headers.get("content-type") === "image/png");
  check("the format substitution is declared, not silent",
    (res.headers.get("x-adapter-format-note") ?? "").includes("no webp"));
}

console.log("\nHTTP — errors and sessions");
{
  const res = await post("/mouse/move", { x: 5000, y: 10 });
  check("an off-display coordinate is a 400", res.status === 400, String(res.status));
  check("the error says what was wrong", ((await res.json()).error ?? "").includes("x must be"));
}
{
  const res = await post("/mouse/move", { x: 1, y: 1 }, { "X-Sandbox-Session": "other-session" });
  const call = executed.at(-1);
  check("the session header is honoured", res.status === 204 && call !== undefined);
}
{
  await post("/desktop/path-session/mouse/move", { x: 2, y: 2 });
  check("a /desktop/<id> prefix is honoured", lastGesture()?.args.join(" ") === "mousemove 2 2");
}
{
  const res = await post("/mouse/move", "not json");
  check("a non-JSON body is a 400", res.status === 400);
}
{
  const res = await fetch(`${base}/mouse/move`, { method: "GET" });
  check("GET on a gesture is 405 with Allow", res.status === 405 && res.headers.get("allow") === "POST");
}
{
  const res = await post("/nope");
  check("an unknown operation is a 404", res.status === 404);
}
{
  // The sandbox provisions lazily, so a typo'd id would otherwise boot a
  // 1.5 GiB desktop VM and report 204 for a screen nobody is watching.
  const before = executed.length;
  const res = await post("/mouse/move", { x: 1, y: 1 }, { "X-Sandbox-Session": "typo-session" });
  check("an unknown session is refused rather than provisioned", res.status === 404, String(res.status));
  check("the refusal says how to get the other behaviour",
    ((await res.json()).error ?? "").includes("ADAPTER_AUTOCREATE"));
  check("no command was sent to the guest for it", executed.length === before, `${executed.length - before} calls`);
}
{
  const res = await fetch(`${base}/openapi.json`);
  const spec = await res.json();
  check("the adapter serves its own schema", res.status === 200 && spec.openapi === "3.0.3");
  const paths = Object.keys(spec.paths);
  check("the schema covers all seven operations",
    ["/screenshot", "/mouse/move", "/mouse/click", "/mouse/scroll", "/keyboard/type", "/keyboard/key", "/wait"]
      .every((p) => paths.includes(p)),
    paths.join(","));
}

proc.kill("SIGTERM");
stub.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
