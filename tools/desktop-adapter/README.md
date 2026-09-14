# Desktop-control adapter

Serves the Box Desktop Control schema — `/screenshot`, `/mouse/*`,
`/keyboard/*`, `/wait` — backed by an agent-sandbox `desktop` session. Each
operation becomes one `/exec` call, carried out by `xdotool` and `scrot` inside
the guest microVM.

```bash
cd tools/desktop-adapter
SANDBOX_KEY=sk_live_... DESKTOP_SESSION=desk-1 npm start   # http://127.0.0.1:6100
```

No dependencies to install; it uses only the Node standard library.

```bash
curl -X POST localhost:6100/mouse/click -H 'Content-Type: application/json' \
     -d '{"x":640,"y":400,"button":"left","holdDurationMs":750}'      # 204

curl -X POST localhost:6100/screenshot -o screen.png                   # binary
```

The adapter serves its own schema at `GET /openapi.json`, describing what it
actually does rather than what the reference schema assumes.

## Why this is a separate service

The sandbox's REST surface is session-scoped and command-oriented; this schema
is stateless and gesture-oriented. Merging them would give one service two
incompatible ideas of what a session is. Nothing in `src/` changed to support
this — the adapter uses only the public API.

## Where the session comes from

The schema names no session; every sandbox call needs one. Resolved
most-explicit-first, so the schema's literal paths work unchanged while
multi-session callers are still served:

| Precedence | Form |
|---|---|
| 1 | `POST /desktop/{sessionId}/mouse/click` |
| 2 | `X-Sandbox-Session: desk-2` header |
| 3 | the `DESKTOP_SESSION` default |

**An unknown session is refused with 404, not created.** The sandbox provisions
lazily — any id it has not seen boots a microVM — so a typo would otherwise cost
a 1.5 GiB desktop VM and answer `204` for a screen nobody is watching. Pass
`ADAPTER_AUTOCREATE=true` if provisioning on demand is what you want.

## Where it departs from the reference schema

Each of these is a place the schema assumes something this backend cannot
honour literally.

**Coordinate bounds.** The schema hardcodes `0–1279` / `0–799`. `DESKTOP_GEOMETRY`
is a per-template setting, so bounds are read from the session's real display at
first use and cached. An out-of-range coordinate is a 400 rather than a click
landing off-screen.

**Screenshot format.** The schema declares `image/webp`. `scrot` writes PNG, and
whether the guest can re-encode depends on `libwebp-tools` being in the template.
WebP is served when the guest has `cwebp`, PNG otherwise, negotiated with
`Accept`. A PNG fallback carries `X-Adapter-Format-Note` so the substitution is
stated rather than inferred from the bytes. Templates built before this was added
serve PNG until rebuilt.

**Scroll is lossy.** X11 scrolling is discrete wheel notches, not pixels. `deltaY`
is divided by `SCROLL_PIXELS_PER_NOTCH` and rounded; any nonzero delta becomes at
least one notch, and fractional notches cannot be expressed. `deltaX` maps to
buttons 6 and 7, which some toolkits ignore.

**Failures are not 204.** The sandbox answers HTTP 200 for a command that ran and
failed — the failure lives in `exitCode`. A gesture whose command exits nonzero
answers **502** with the guest's stderr, so a click cannot be reported as
delivered when `xdotool` could not reach the display.

**`/wait` waits here, not in the guest.** Sending it across would hold that
session's command lock for the duration, blocking the very screenshot the caller
is waiting to take.

## Injection safety

Everything is emitted as argv — `{command, args}` — and never as a shell line.
The sandbox spawns argv directly, so caller text cannot be interpreted:

```bash
curl -X POST localhost:6100/keyboard/type -H 'Content-Type: application/json' \
     -d '{"text":"; rm -rf / && $(id)"}'
```

types those characters into the focused field. A single `sh -c` in the
translation layer would undo that for every route at once, which is why
`translate.mjs` is pure and returns argv only. The one place a shell is used —
staging a screenshot — interpolates no caller input.

Key names are validated against `^[A-Za-z0-9_]{1,32}$` even so, because
`xdotool` itself parses that string and `a+b` means something to it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_KEY` | *(required)* | API key with the `exec` scope |
| `SANDBOX_URL` | `http://127.0.0.1:3000` | Where the sandbox listens |
| `DESKTOP_SESSION` | `desk-1` | Session used when a request names none |
| `DESKTOP_TEMPLATE` | `desktop` | Template for provisioning, when enabled |
| `ADAPTER_PORT` | `6100` | Port for this adapter |
| `ADAPTER_BIND` | `127.0.0.1` | Bind address |
| `ADAPTER_AUTOCREATE` | `false` | Allow an unknown session to boot a VM |
| `SCROLL_PIXELS_PER_NOTCH` | `100` | Pixel-to-notch divisor for scroll |
| `TYPE_DELAY_MS` | `12` | Inter-keystroke delay for `/keyboard/type` |

## Security

The adapter holds an API key and has no authentication of its own, so it binds
loopback. Anyone who reaches the port has keyboard and mouse control of the
session. Unlike `tools/novnc-viewer` and `tools/sandbox-console` it needs no
`Origin` check, because it has no browser-facing page and no WebSocket — it is
a machine-to-machine API. Putting it behind anything browser-reachable means
adding those guards first.

## Tests

```bash
npm test
```

Sixty-five cases, no microVM required. The translation layer is pure, so its
cases run with no server at all; the HTTP layer runs against a stub sandbox that
records the argv it is asked to execute, so each route is checked by what it
would do to a guest rather than by whether it answered 204.
