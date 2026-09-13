# noVNC viewer

Watch a `desktop` session's screen in a browser, and drive it with mouse and
keyboard.

```bash
cd tools/novnc-viewer
npm install
SANDBOX_KEY=sk_live_... npm start
```

Then open <http://127.0.0.1:6080>. Type a session id, press **Boot desktop** if
that session is not running yet, then **Connect**.

From a workstation, tunnel to it rather than exposing the port:

```bash
ssh -N -L 6080:127.0.0.1:6080 <user>@<sandbox-host>
```

## Why a proxy exists at all

`GET /exec/:id/vnc` authenticates with a `Authorization: Bearer` header, and the
browser `WebSocket` API cannot set headers. The obvious workaround — accepting
`?access_token=` on the VNC route — is the reason this proxy exists instead:
a token in a URL is written to the server's access log, kept in browser history,
and sent in `Referer` to anything the page later loads. `src/routes/vnc.ts`
deliberately reads the header only.

So the browser connects here with no credentials, and this process holds the key
and adds the header when it dials the sandbox:

```
browser ──ws (no auth)──▶ viewer :6080 ──ws + Bearer──▶ sandbox :3000 ──vsock──▶ Xvnc in guest
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_KEY` | *(required)* | API key with the `exec` scope |
| `SANDBOX_URL` | `http://127.0.0.1:3000` | Where the sandbox listens |
| `VIEWER_PORT` | `6080` | Port for this viewer |
| `VIEWER_ALLOWED_ORIGINS` | `http://127.0.0.1:$PORT`, `http://localhost:$PORT`, `http://[::1]:$PORT` | Comma-separated `Origin` allowlist for the bridge |

## Security

This viewer has **no authentication of its own** and holds an API key. Anyone who
can reach its port drives every desktop session that key can reach, with no
further credentials. Do not bind it to `0.0.0.0`, and do not put it behind a
plain reverse proxy without adding authentication in front.

It is a local operator tool. It is not the multi-user console — that is `webui/`.

### Why loopback binding is not enough on its own

Binding `127.0.0.1` keeps other *hosts* out. It does nothing about the browser
already running on this machine: **WebSocket handshakes are exempt from the
same-origin policy** — no preflight, no CORS — so any page on any site the
operator visits could otherwise open

```
ws://127.0.0.1:6080/websockify?session=desk-1
```

and this process would attach the API key on its behalf, handing that page a
live RFB channel with keyboard and mouse. Session ids need no guessing; this
README uses `desk-1`.

So the bridge checks `Origin` against an allowlist, and `Host` as well — a page
on a name that has been DNS-rebound to `127.0.0.1` is same-origin to the browser
and therefore sends no `Origin` at all, but its `Host` header still carries the
attacker's name. Both checks cover `/api/*` too, or a cross-site form post could
boot VMs. A request with no `Origin` at all is allowed: that is a non-browser
client such as `curl`, which is not this threat — the attack needs a victim's
browser.

Override the allowlist with `VIEWER_ALLOWED_ORIGINS` (comma-separated) if you
front the viewer with something else.

`npm test` covers all of this; run it after touching `server.mjs`.

## Requirements

A `desktop`-class template must be built (`sudo ./templates/build.sh desktop`),
or there is no X server in the guest and the VNC route answers 502.
