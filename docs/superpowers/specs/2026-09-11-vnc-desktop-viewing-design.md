# VNC Desktop Viewing for Browser Sessions

**Date:** 2026-09-11
**Status:** Approved, not implemented

## Goal

Let a web app watch the desktop inside a running `browser` microVM session — see the pages Chromium is driving, live — without weakening the isolation boundary the sandbox rests on.

## Non-Goals

- **Remote control.** The stream is view-only. Input events are not forwarded.
- **Multi-user collaboration.** No presence, cursors, or session sharing beyond multiple read-only viewers.
- **Recording or playback.** Frames are relayed, never stored.
- **Desktop applications.** The X display exists to show Chromium, not to be a general desktop.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Interaction | View-only | A leaked stream leaks a view, not control of the VM. Enforced by `x11vnc -viewonly` in the guest, at the source. |
| Placement | Extend `templates/browser` | One template to maintain; every browser session is observable by default. |
| Transport | Second vsock port (5901) | Reuses the existing `CONNECT <port>` pattern. No iptables change, no inbound network path to the guest. |
| WS auth | API key in query string | Chosen by the project owner over a short-lived ticket, with the logging tradeoff understood. See Security. |
| Deliverable | WS endpoint + minimal noVNC viewer page | Something clickable to verify the chain; real web apps use the endpoint directly. |

## Architecture

```
Browser (noVNC)
    │  WebSocket, binary RFB frames
    ▼
Host: src/vnc/relay.ts
    │  verifyKey → scope "exec" → session exists → assertOwnership → VM alive
    │  route: ws://host/vnc/:sessionId/stream?key=…
    │  net.Socket to <jail>/run/vsock.socket, "CONNECT 5901\n"
    ▼
Firecracker vsock
    ▼
Guest: socat VSOCK-LISTEN:5901,fork → TCP:127.0.0.1:5901
    ▼
x11vnc -viewonly -localhost -display :0
    ▼
Xvfb :0 1280x720x24  ←  headful Chromium
```

The relay opens its **own** vsock connection. It must not share `vm.socket`, which is
serialized by `acquireVmLock` for the request/response JSON protocol and cannot carry a
long-lived stream.

## Components

### `templates/browser/template-init.sh` (new)

Starts the display stack, backgrounded, in order: `Xvfb :0 -screen 0 1280x720x24`, then
`x11vnc -display :0 -rfbport 5901 -localhost -viewonly -forever -shared -nopw`, then
`socat VSOCK-LISTEN:5901,fork TCP:127.0.0.1:5901`.

Runs before the snapshot is taken, so a restored VM has the display stack already live.

No window manager. Chromium maps its own window at the requested size; a WM would add
memory and processes for no benefit to an observation-only display.

### `minimal-rootfs/start.sh` (modified)

Gains one generic hook, matching the file's existing guarded style:

```sh
[ -x /template-init.sh ] && /template-init.sh 2>/dev/null || true
```

The base image stays template-agnostic. Templates that need extra boot work supply the
script; those that don't are unaffected.

### `src/vnc/relay.ts` (new)

Exports `installVncRelay(httpServer)`, attached in `src/server.ts` where the server handle
already exists. Owns the upgrade handshake, authentication, the vsock connection, and the
byte pipe. Express middleware does not run on upgrades, so authentication is re-implemented
here deliberately rather than inherited.

Serves `ws://host/vnc/:sessionId/stream?key=…`. Deliberately **not** under `/exec`: that
mount is behind `authMiddleware` and `requireOwnership` (`src/app.ts:43`), which read the
`Authorization` header only. Keeping the query-string exception on its own `/vnc` prefix
makes the surface explicit instead of burying it inside the header-only namespace.

### `src/vnc/viewer.ts` (new)

Serves a self-contained page at `GET /vnc/:sessionId/view`, registered outside the `/exec`
mount, that loads noVNC from a CDN and connects to the stream endpoint.

The page itself is **unauthenticated**: it is static HTML containing no secrets. It reads
`?key=` from its own URL purely to build the WebSocket URL, and all authorization happens at
the upgrade. Guarding the page would add an auth path that protects nothing — the stream is
where access is decided. Diagnostic aid, not a product surface.

### `src/logger.ts` (modified)

Redacts the query string on VNC request URLs so the API key does not reach access logs.

## Data Flow

### Connect

1. The web app already has a live session, created by any `/exec` call with
   `"template": "browser"`.
2. It opens `ws://host:3000/vnc/:sessionId/stream?key=sk_test_...`.
3. The upgrade handler checks, in order: parse URL → `verifyKey` → require `exec` scope →
   `getSession` must exist → `assertOwnership` → VM must not be dead or cleaned.
4. `connectVsock(vm.vsock)`, write `CONNECT 5901\n`, then **read until the first newline**
   and verify the line starts with `OK`.
5. Complete the WS upgrade only after the vsock connection succeeds, so failures surface as
   HTTP status codes rather than a WebSocket that opens and immediately closes.

### The handshake line matters

`src/vm/protocol.ts:52` skips lines beginning with `OK`, which is why the JSON protocol
tolerates Firecracker's `OK <port>\n` reply without ever consuming it explicitly — that
protocol is line-framed.

RFB is raw binary with no framing. If the relay pipes the handshake line through, noVNC
reads `OK 1234\n` where it expects `RFB 003.008\n` and fails on the first byte. The relay
must consume exactly that line and forward any bytes that follow it in the same chunk,
since the first RFB data can arrive in the same TCP segment.

### Stream

`socket.on("data")` → `ws.send(chunk, { binary: true })`, and `ws.on("message")` →
`socket.write(data)`.

The pipe is bidirectional even though the stream is view-only: an RFB client must send
`SetPixelFormat`, `SetEncodings`, and `FramebufferUpdateRequest` or no frames ever arrive.
View-only is enforced by `x11vnc -viewonly`, which discards pointer and key events in the
guest. The relay stays a dumb byte pipe and never parses RFB.

### Backpressure

When `ws.bufferedAmount` exceeds 1 MiB, `socket.pause()`; resume when it drains. x11vnc will
outrun a slow viewer, and without this a bad connection grows host memory without bound.

### Teardown

Either side closing destroys the other. Live relays are tracked in a `Set` so session
destruction and server shutdown close them; otherwise a VM teardown leaves a socket pointing
into a removed jail.

## Error Handling

Authentication failures are written as raw HTTP responses on the upgrade socket **before**
upgrading. After the upgrade the browser sees only an opaque close code, which makes
misconfiguration undiagnosable.

| Condition | Response |
|---|---|
| Missing or invalid key | `401` |
| Key lacks `exec` scope | `403` |
| Session does not exist | `404` — viewing never provisions a VM |
| Key does not own the session | `403`, via the existing `assertOwnership` |
| VM dead or cleaned | `409` |
| vsock connect fails, or handshake line is not `OK` | `502` |
| Guest VNC not listening (non-browser template) | `502` |

Metrics follow `src/metrics.ts` conventions: a `vnc_connections_active` gauge and a
`vnc_connections_total` counter labelled by result.

## Security

**The API key travels in the WebSocket URL.** This was chosen over a short-lived ticket. The
consequences, and what is done about them:

- **Server access logs:** mitigated. `src/logger.ts` redacts the query string for this route.
- **Browser history, `Referer` headers, intermediate proxy logs:** not mitigated. Redaction
  cannot reach them. A key used for VNC viewing should be treated as exposed to the browser
  environment, and rotated rather than shared.
- **Scope of the change:** `extractKey` in `src/auth/middleware.ts` is untouched. `/exec` and
  every other REST route remain header-only. The VNC upgrade path has its own handler, and
  the query-string exception applies only there.

The README's OWASP claim about header-only authentication must be scoped to the REST API,
with the VNC endpoint documented as the stated exception. Leaving that claim unqualified
would make it false.

**Remaining properties.** The guest's VNC port is reachable only over vsock: `x11vnc` binds
`-localhost` and no iptables rule is added, so the guest gains no inbound network exposure.
`-nopw` is acceptable because reachability, not a VNC password, is the control — and any
process already inside the guest is by definition running agent code. Ownership is enforced
per session, so one key cannot view another key's desktop.

## Resource Sizing

Headful Chromium plus a 1280×720×24 framebuffer does not fit comfortably in the current
1024 MiB. Rebuild the browser template at:

```
VM_MEM_SIZE_MIB=1536
VM_MEMORY_LIMIT_BYTES=2147483648
```

The framebuffer itself is ~3.7 MiB; the cost is headful Chromium's larger working set, plus
Xvfb, x11vnc, and their copies of the screen.

## Behaviour Change

Chromium must run **headful**. `chromium.launch()` defaults to headless and renders nothing
an X server can show. Scripts need `headless: false` and `DISPLAY=:0`, which the template
sets in `/etc/environment`. The README's working example changes accordingly.

## Testing

**Unit (no KVM required).** The relay's logic is separable from Firecracker:

- handshake parser consumes `OK 1234\n`, forwards trailing bytes from the same chunk, and
  rejects a line that does not start with `OK`
- each authentication rejection path returns the correct status before upgrading
- backpressure pauses and resumes the socket at the threshold
- teardown closes both sides and removes the relay from the tracking set

**Integration (requires KVM).** Extends the `src/vm/vm-e2e.test.ts` pattern: boot a browser
VM, connect the relay, assert the first bytes match `RFB 003.00`. That single assertion
covers the whole chain — it can only appear if Xvfb, x11vnc, socat, vsock, and handshake
stripping all work.

The weak spot is that `x11vnc` serves an empty desktop just as happily as a populated one.
The integration test must launch a headful page and assert the framebuffer is not uniform,
or it will pass against a blank screen.

**Manual.** Load `/vnc/:id/view?key=…` while a Playwright script navigates, and watch it
render.

## Files Touched

| File | Change |
|---|---|
| `templates/browser/Dockerfile` | add `xvfb`, `x11vnc`, `socat`; set `DISPLAY` in `/etc/environment` |
| `templates/browser/template-init.sh` | new — boot the display stack |
| `minimal-rootfs/start.sh` | run `/template-init.sh` when present |
| `src/vnc/relay.ts` | new — WS upgrade, auth, vsock relay |
| `src/vnc/viewer.ts` | new — minimal noVNC page, mounted at `/vnc` outside the `/exec` auth |
| `src/server.ts` | call `installVncRelay(httpServer)` |
| `src/session/session.ts` | close relays in `destroySession` (line 47) |
| `src/shutdown.ts` | close relays on shutdown |
| `src/logger.ts` | redact VNC query strings |
| `src/metrics.ts` | VNC gauge and counter |
| `package.json` | add `ws` and `@types/ws` |
| `README.md` | VNC usage; scope the OWASP claim; headful example |

## Open Questions

None blocking. Two things to revisit after it works:

- Whether multiple simultaneous viewers per session need a cap.
- Whether the 1 MiB backpressure threshold is right under real network conditions; it is a
  starting value, not a measured one.
