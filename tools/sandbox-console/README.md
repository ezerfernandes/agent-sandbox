# Operator console

A single page that drives a running agent-sandbox: the guest's desktop live, a
shell in the same session, its filesystem, and a scripted agent that works the
guest while you watch.

```bash
cd tools/sandbox-console
npm install
SANDBOX_KEY=sk_live_... npm start          # http://127.0.0.1:6090
```

From a workstation, tunnel rather than exposing the port:

```bash
ssh -N -L 6090:127.0.0.1:6090 <user>@<sandbox-host>
```

Use the **same local port**. The Origin allowlist is built from the console's
own port, so tunnelling `6090` to a different local port answers 403.

## What the four panels do

| Panel | Uses | Shows |
|---|---|---|
| Desktop | `GET /exec/:id/vnc` | The guest's X display, interactive |
| Agent | `/execute`, `/write`, `/read` | A driver outside the VM working it, step by step |
| Shell | `/execute?format=ndjson`, `/cancel` | Output streaming as the guest produces it |
| Files | `/files`, `/read` | `/workspace`, with images rendered inline |

Only `desktop` sessions have an X server. With `browser` or `node` selected the
desktop panel stays dark, which is correct rather than broken — the browser
template renders offscreen and hands back PNGs.

## The agent

"Agent" here means a program **outside** the microVM driving it through the
public API — the position a real LLM-backed agent occupies. The tasks in
`agent.mjs` are scripted rather than model-driven, deliberately: what you are
watching should be the sandbox's behaviour, not a model's.

A task is a list of steps, each an async function handed a small context:

```js
{
  title: "Wait for the window to report the page title",
  detail: "polling xdotool from the host instead of sleeping a fixed time",
  run: async (ctx) => {
    const title = await waitFor(ctx, "xdotool search --onlyvisible --name . getwindowname %@ | head -1",
                                { what: "the page title" });
    return { output: title };
  },
}
```

`ctx` offers exactly `exec`, `write` and `read`. An agent gets no privileged
back door that the console itself lacks. Returning `image` renders a screenshot
inline in the run log; `output` becomes a terminal block; `note` a caption.

Add a task by appending to `TASKS` — the UI discovers it through `/api/tasks`,
including its step titles, with no client change.

## Security

The console has **no authentication of its own** and holds an API key, so anyone
who reaches its port drives every session that key can reach. It binds
`127.0.0.1` for that reason. Do not bind it to `0.0.0.0` or put it behind a plain
reverse proxy without adding authentication in front.

Loopback binding is not sufficient on its own, and the reason is worth stating.
**WebSocket handshakes are exempt from the same-origin policy** — no preflight,
no CORS — so any page the operator visits could otherwise open the bridge and
have this process attach the key on its behalf: a live keyboard and mouse
channel into the desktop. `Origin` is therefore checked against an allowlist,
and `Host` alongside it, because a name DNS-rebound to `127.0.0.1` is
same-origin to the browser and sends no `Origin` at all. Both guards cover
`/api/*` as well as the upgrade, or a cross-site form post could boot VMs.

A request with no `Origin` is allowed: that is a non-browser client such as
`curl`, which is not this threat, since the attack requires a victim's browser.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_KEY` | *(required)* | API key with the `exec` scope |
| `SANDBOX_URL` | `http://127.0.0.1:3000` | Where the sandbox listens |
| `CONSOLE_PORT` | `6090` | Port for this console |
| `CONSOLE_ALLOWED_ORIGINS` | the three loopback spellings of `CONSOLE_PORT` | Comma-separated `Origin` allowlist |

## Tests

```bash
npm test
```

Twenty cases against a stub sandbox, so they need no microVM, no key and no
desktop template: both guards on the upgrade and on `/api/*`, that the key never
reaches the browser, that NDJSON survives translation to SSE when a line is
split across chunks, and that the agent loop reports every step.

## Relationship to the other tools

`tools/novnc-viewer` is the minimal viewer — a desktop and nothing else. This is
the superset. Neither is `webui/`, which is the multi-user console; both of
these are single-operator tools that assume a trusted machine.
