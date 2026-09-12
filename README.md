<!-- prettier-ignore -->
<div align="center">

# Agent Sandbox

*Secure, hardware-isolated execution sandbox for AI agents using Firecracker microVMs*

[![Node.js](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Firecracker](https://img.shields.io/badge/Firecracker-v1.16-E6522C?style=flat-square&logo=rust&logoColor=white)](https://firecracker-microvm.github.io/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io/)
[![Linux KVM](https://img.shields.io/badge/Virtualization-Linux_KVM-FCC624?style=flat-square&logo=linux&logoColor=black)](https://www.kernel.org/doc/Documentation/virtual/kvm/api.txt)
[![License](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](LICENSE)

⭐ If you like this project, star it on GitHub!

[Overview](#overview) • [Architecture](#architecture) • [Capabilities](#capabilities) • [Getting Started](#getting-started) • [Integration & SDKs](#integration--sdks) • [Security Model](#security-model) • [Performance](#performance--benchmarks) • [Configuration](#configuration)

</div>

---

## Overview

AI agents need to perform real-world actions: generate and execute code, install third-party dependencies, query remote APIs, run background processes, and manipulate files. Running untrusted, agent-generated code on the host machine is dangerous, while conventional container sandboxing shares the host kernel—leaving systems vulnerable to kernel exploits, dirty sysctls, and resource exhaustion.

**Agent Sandbox** provides each AI agent session with a dedicated [Firecracker](https://firecracker-microvm.github.io/) microVM. Sessions boot in milliseconds from pre-baked snapshots, run in complete hardware isolation with their own Linux kernel, and are automatically torn down when execution completes.

> [!NOTE]
> **Sub-100ms Cold Starts**: By combining Firecracker snapshot restoration with pre-provisioned root filesystems, microVM guest state restores in **~2.6ms** (total end-to-end cold start is **~90ms** including dedicated Linux network namespace, veth pair, TAP device, and NAT egress provisioning).

---

## Architecture

Agent Sandbox separates untrusted guest execution from the host control plane through strict virtualization and network boundaries.

<p align="center">
  <img width="100%" alt="Agent Sandbox Architecture Diagram" src="https://github.com/user-attachments/assets/6d25473f-161f-4bff-b2f1-a6b085e7ea7e"/>
</p>

<details>
<summary>View Text Architecture Diagram</summary>

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           Host (Linux + KVM)                            │
│                                                                         │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────┐  │
│  │   Express REST API   │  │      MCP Server      │  │    Metrics    │  │
│  │       /exec/*        │  │     stdio / SSE      │  │   /metrics    │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └───────┬───────┘  │
│             │                         │                      │          │
│             └───────────┬─────────────┘                      │          │
│                         ▼                                    │          │
│             ┌───────────────────────┐   ┌───────────────────────────┐   │
│             │    Session Gateway    ├──►│     Template Registry     │   │
│             │ (Lazy initialization) │   │   (Node, Python, Go...)   │   │
│             └───────────┬───────────┘   └───────────────────────────┘   │
│                         ▼                                               │
│             ┌───────────────────────┐                                   │
│             │      VM Manager       │                                   │
│             │ (Jailer chroot + KVM) │                                   │
│             └───────────┬───────────┘                                   │
│                         │                                               │
│    ┌────────────────────┴──────────────────────────────────────────┐    │
│    │                  Per-VM Network Namespace                     │    │
│    │   veth pair ── TAP device ── iptables NAT ── dnsmasq filter   │    │
│    └────────────────────┬──────────────────────────────────────────┘    │
│                         │ vsock channel                                 │
│    ╔════════════════════╧══════════════════════════════════════════╗    │
│    ║                 Firecracker microVM (Guest)                   ║    │
│    ║                                                               ║    │
│    ║   ┌───────────────────────┐     ┌─────────────────────────┐   ║    │
│    ║   │   Guest Runtime.js    │────►│  /workspace (tmpfs RAM) │   ║    │
│    ║   └───────────────────────┘     └─────────────────────────┘   ║    │
│    ║               ▲                                               ║    │
│    ║               │                                               ║    │
│    ║      socat ◄──┴──► vsock:5000 (Host-to-Guest IPC)             ║    │
│    ╚═══════════════════════════════════════════════════════════════╝    │
└─────────────────────────────────────────────────────────────────────────┘
```
</details>

### Execution Flow

1. **Session Request**: An agent issues a command through the TypeScript SDK, MCP protocol, or REST API, specifying an optional template (`node`, `python`, `go`).
2. **Snapshot Lookup**: The **Session Gateway** checks for an active instance. If cold, it fetches pre-baked snapshot state from the **Template Registry** and restores the microVM in ~2.6ms.
3. **Network Isolation**: The host configures a dedicated **Linux network namespace** with an isolated veth pair, TAP device, custom routing table, and iptables rules.
4. **Vsock Dispatch**: Commands and payloads stream directly to the guest runtime over a zero-network **vsock** channel.
5. **Reaping & Teardown**: Inactive sessions are automatically reaped after an idle timeout (default: 30 minutes), removing the jail chroot, network namespace, and cgroup slices.

### Network Packet Path & Isolation Boundary

```text
MicroVM Guest (eth0: 192.168.241.2/29)
    ↓
tap0 (192.168.241.1/29) — Inside Per-VM Network Namespace
    ↓
Per-Namespace iptables:
  ├── PREROUTING: Transparent DNS redirection (UDP/TCP 53 → local dnsmasq)
  ├── FORWARD → VM_EGRESS: Cloud metadata block (169.254.169.254/32) + optional CIDR rules
  └── POSTROUTING: MASQUERADE 192.168.241.0/29 outbound to vethNs
    ↓
vethNs (10.0.{slot}.1/30)
    ↓ (veth pair across network namespace boundary)
vethHost (10.0.{slot}.2/30) — On Host
    ↓
Host-Level iptables:
  ├── INPUT: DROP all incoming traffic from 10.0.0.0/16 to host daemon ports
  ├── FORWARD: DROP 169.254.169.254/32 (Defense-in-depth metadata blocking)
  ├── FORWARD: DROP 10.0.0.0/16 → 10.0.0.0/16 (Strict cross-tenant VM isolation)
  ├── FORWARD: ACCEPT 10.0.0.0/16 outbound & return conntrack
  └── POSTROUTING: MASQUERADE 10.0.0.0/16 outbound to physical WAN interface
    ↓
Internet
```

---

## Capabilities

| Capability | Details |
|---|---|
| **Hardware Virtualization** | Full hardware isolation via KVM; each microVM runs its own guest Linux kernel. |
| **Instant Cold Boot** | Resumes snapshotted microVM state in ~2.6ms (sub-100ms total API round-trip). |
| **Pre-built Templates** | Ready-to-use environments for **Node.js 22**, **Python 3.12**, and **Go 1.23**. |
| **Custom Dockerfile Snapshots** | Build custom runtime snapshots directly from any Dockerfile using the included pipeline. |
| **Real-time Output Streaming** | Stream stdout/stderr in real-time over NDJSON HTTP chunks or SDK async iterables. |
| **Isolated Filesystem** | In-memory 512MB `/workspace` (tmpfs) with path-traversal prevention. |
| **Full Network Stack** | Outbound HTTP/HTTPS access, transparent DNS interception, and configurable CIDR allow/deny lists. |
| **Process Control** | Command timeouts, cancellation via `SIGTERM`/`SIGKILL`, and exit code tracking. |
| **Agent Protocols** | First-class **Model Context Protocol (MCP)** support (stdio and SSE) alongside typed SDKs. |

### Environment Templates

Agent Sandbox comes with five pre-configured templates:

* **`node`** (Default): Alpine Linux 3.20 + Node.js 22 + npm + git + curl
* **`python`**: Alpine Linux 3.20 + Python 3.12 + pip + git + curl
* **`go`**: Alpine Linux 3.20 + Go 1.23 + git + curl
* **`browser`**: Alpine Linux 3.20 + Chromium + Playwright (`playwright-core`) — for agents that browse the live web
* **`desktop`**: Alpine Linux 3.20 + Xvnc + openbox + Chromium + `xdotool`/`scrot` — a real X session an agent can drive and a human can watch over VNC

#### Building & Creating Custom Templates

Build any bundled or custom template using the snapshot script:

```bash
# Build bundled templates
sudo ./templates/build.sh node
sudo ./templates/build.sh python
sudo ./templates/build.sh go
```

To create a custom environment, create a directory under `templates/<template-name>/` with a `Dockerfile`:

```dockerfile
FROM agent-sandbox-base:latest

RUN apk add --no-cache ruby rust cargo postgresql-client

LABEL template.name="data-science" \
      template.displayName="Data Science & Rust" \
      template.tools="ruby,rustc,cargo,psql"
```

Build the snapshot:

```bash
sudo ./templates/build.sh data-science
```

Custom templates run under three constraints worth designing around:

* **The guest root filesystem is read-only.** Anything the runtime needs to write — caches, profiles, lock files — must live under `/workspace` or `/tmp`, both tmpfs. Warm any build-time cache (`fc-cache`, bytecode, package indexes) during `docker build`.
* **Dockerfile `ENV` does not reach the guest.** `build.sh` ships the filesystem with `docker export`, which carries no image config. Write runtime variables to `/etc/environment`, which `start.sh` sources at boot.
* **`docker export` carries no device nodes.** `start.sh` mounts `/proc`, `/sys`, `devtmpfs` on `/dev`, `devpts`, and `/dev/shm` at boot so the guest has a working environment.
* **Daemons start from `/etc/sandbox/boot.d/*.sh`.** `start.sh` runs every hook there — after the pseudo-filesystems are mounted, before it prints `READY` — in lexical order, and a failing hook is logged rather than allowed to abort the boot. A hook **must not return until its daemons are actually serving**: `create_snapshot.ts` freezes guest memory the moment it sees `READY`, so anything half-started then is frozen half-started into every VM restored from that snapshot. `templates/desktop/boot.d/10-desktop.sh` is the worked example — it waits for `xdpyinfo` and for the RFB port to accept a connection before returning.
* **Per-template sizing belongs in `build.env`.** `templates/<name>/build.env` is sourced by `build.sh` before anything else runs; write defaults as `: "${VM_MEM_SIZE_MIB:=1536}"` so an explicitly exported value still wins.

Editing `minimal-rootfs/start.sh` or `templates/base/Dockerfile` changes the shared base image, so **every** template must be rebuilt for the change to take effect — existing snapshots keep the old boot script.

#### Building the Browser Template

The `browser` template needs far more RAM, CPU, and disk than the language templates. Those values are read from the environment at build time and baked into the template's `template.json`, so the server applies them per-session at restore. No global configuration change is needed, and the other templates keep their tight defaults.

```bash
sudo -E ./templates/build.sh browser
```

Those values live in `templates/browser/build.env`, which `build.sh` sources for any template that ships one. Override a single value on the command line and it still wins:

```bash
sudo -E env VM_MEM_SIZE_MIB=2048 ./templates/build.sh browser
```

> [!IMPORTANT]
> `sudo -E` is still required for the overrides. Without `-E`, sudo resets the environment and anything you exported yourself is dropped before `build.sh` runs.

> [!NOTE]
> If Node.js is installed through nvm, fnm, or volta, it lives under your home directory and sudo's `secure_path` hides it. `build.sh` probes those locations automatically; if it still cannot find an interpreter, pass one explicitly with `NODE_BIN="$(command -v node)"` in the same `env` list.

Chromium is the Alpine system package, not a Playwright-managed download — Playwright's bundled browser builds are glibc-only and will not run on musl. Drive it through `playwright-core` with an explicit executable path:

```js
const { chromium } = require("playwright-core");

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
```

`--no-sandbox` is appropriate here: Chromium's own sandbox is redundant inside a Firecracker microVM, which is already the isolation boundary. `--disable-dev-shm-usage` is optional — `start.sh` mounts a 256 MiB tmpfs on `/dev/shm` — but keeping it moves Chromium's shared memory to `/tmp` and costs nothing.

Do **not** pass `--user-data-dir` to `launch()` — Playwright rejects it and directs you to `launchPersistentContext(userDataDir, options)`. Playwright creates its own profile under `/tmp`, which is tmpfs and writable; the read-only root filesystem is not a problem here.

#### Browser Template: End-to-End Test

With the template built and the server running, this sequence navigates a page and returns a screenshot.

**1. Write the script.** Screenshots have to be base64-encoded inside the guest — see the warning below.

```bash
cat > /tmp/shot.js <<'EOF'
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  console.log("title:", await page.title());
  const shot = await page.screenshot({ path: "/workspace/shot.png", fullPage: true });
  console.log("bytes:", shot.length);
  await browser.close();
})();
EOF
```

**2. Upload it, naming the template.** This call provisions the microVM, so the `template` field belongs here — see the session-binding note in the REST API section.

```bash
curl -s -X POST http://localhost:3000/exec/browse-1/write \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$(jq -Rs '{path:"shot.js", template:"browser", content:.}' < /tmp/shot.js)"
# {"bytesWritten":604}
```

**3. Run it.**

```bash
curl -s -X POST http://localhost:3000/exec/browse-1/execute \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"template":"browser","command":"node","args":["shot.js"],"timeout":120000}'
# {"exitCode":0,"duration":3350,"output":[{"stream":"stdout","data":"title: Example Domain\n"},...]}
```

**4. Retrieve the screenshot.**

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/exec/browse-1/read?path=shot.png&encoding=base64" \
  | jq -r .content | base64 -d > /tmp/shot.png

file /tmp/shot.png
# /tmp/shot.png: PNG image data, 1280 x 720, 8-bit/color RGB, non-interlaced
```

**5. Release the session** — a browser session holds 1.5 GiB of host cgroup budget until it is destroyed or idle-reaped.

```bash
curl -s -X DELETE -H "Authorization: Bearer $KEY" http://localhost:3000/exec/browse-1
```

Launch, navigation, and screenshot together take roughly 3.3 seconds, since every `execute` starts Chromium from scratch. For a navigate/click/extract loop, keep a browser alive with `launchServer` rather than paying that per step.

> [!NOTE]
> `read` decodes to UTF-8 unless you ask otherwise, which corrupts binary data. Pass `encoding=base64` for screenshots and other binary files — the guest's base64 payload then comes back untouched. Earlier revisions of this guide base64-encoded inside the guest and read a `.b64` text file; that workaround is no longer needed.

> [!NOTE]
> Restoring a 1 GiB memory snapshot faults pages in on demand, so the `browser` template does not hit the sub-100ms cold start documented for the language templates. Expect tens of milliseconds.

##### Troubleshooting

| Symptom | Cause |
|---|---|
| `Cannot find module 'playwright-core'` | The session was provisioned from another template. `write` without a `template` field pins the session to the default `node`. Use a fresh session id. |
| Chromium exits with `SIGTRAP` right after launch | The guest is missing `/proc` or `/dev`. Check with `{"command":"sh","args":["-c","mount"]}`; rebuild the template if `start.sh` predates the pseudo-filesystem mounts. |
| `browserType.launch: ... Pass userDataDir parameter` | `--user-data-dir` was passed to `launch()`. Remove it. |
| VM dies mid-run, no Chromium error | Host cgroup OOM. Confirm `resources.memoryLimitBytes` in `template.json` is the value you built with. |
| Screenshot file is not a PNG | The file was read without `encoding=base64`, so the bytes were mangled by the UTF-8 decode. |

---

#### Building the Desktop Template

```bash
sudo -E ./templates/build.sh desktop
```

Sizing comes from `templates/desktop/build.env` (2 GiB rootfs, 2 vCPU, 1536 MiB RAM, 2 GiB cgroup limit), so there is no env list to remember — `sudo -E` is still needed so an explicitly exported override survives, and anything you do export wins over the file. The same mechanism now backs `browser`; `templates/<name>/build.env` is picked up for any template that has one.

What the template adds on top of the base image:

* `Xvnc :1` at `DESKTOP_GEOMETRY` (default `1280x800`, 24-bit), bound to loopback with no VNC password — the only route in is the vsock bridge, which the host gates on an API key.
* `openbox` as the window manager, both under respawn loops so a crash does not leave a black screen.
* `socat VSOCK-LISTEN:5900 → 127.0.0.1:5901`, which is what `GET /exec/:id/vnc` connects to.
* `/etc/sandbox/boot.d/10-desktop.sh`, run by `start.sh` **before** it prints `READY`. That ordering matters: `create_snapshot.ts` freezes guest memory on `READY`, so the hook waits for `xdpyinfo` and the RFB port to answer before returning. A hook that returned early would bake a half-started X session into every restored VM.
* Helper commands on `PATH`: `desktop-launch <cmd>` (detaches a GUI program with `setsid` so `/execute` returns immediately instead of waiting for the window to close), `desktop-chromium [url]` (Chromium with the flags a GPU-less read-only guest needs), `desktop-screenshot [path]` (PNG via `scrot`, default `/workspace/screenshot.png`).
* `desktop-chromium` starts Chromium with `--remote-debugging-port=9222` on purpose, so `playwright-core` can attach to the same window a human is watching over VNC. The port is guest-local: nothing bridges it, and the microVM's only ingress is vsock 5000 (runtime) and 5900 (VNC), both gated on an API key by the host.

Driving it end to end:

```bash
# Open a browser window on the desktop — returns in milliseconds, not when Chromium exits
curl -X POST http://localhost:3000/exec/desk-1/execute \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"template":"desktop","command":"desktop-chromium","args":["https://example.com"]}'

# Take a screenshot and read it back as a real PNG
curl -X POST http://localhost:3000/exec/desk-1/execute \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"command":"desktop-screenshot"}'

curl -H "Authorization: Bearer sk_test_..." \
  "http://localhost:3000/exec/desk-1/read?path=screenshot.png&encoding=base64" \
  | jq -r .content | base64 -d > shot.png

# Synthesise input
curl -X POST http://localhost:3000/exec/desk-1/execute \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"command":"xdotool","args":["key","ctrl+l"]}'
```

> [!NOTE]
> A desktop VM holds 1536 MiB of guest RAM and a memory snapshot of the same order on disk, so plan concurrency well below `VM_MAX_SLOTS`. Chromium is launched on demand rather than baked into the snapshot, which keeps the restore small.

---

## Getting Started

### Prerequisites

* **Linux Host** with hardware virtualization enabled (`/dev/kvm` must exist and be accessible)
* **Firecracker & Jailer** v1.16+ installed in `/usr/local/bin/`
* **Node.js** v20+
* **Docker** (used solely during template build pipeline)
* **Root / sudo privileges** (required for Jailer chroot, cgroups, and network namespaces)

> [!IMPORTANT]
> Agent Sandbox requires Linux KVM acceleration. It cannot run inside standard non-nested containers or on macOS/Windows hosts without nested virtualization support.

### 1. Install Firecracker & Jailer

Download the binaries from the official Firecracker releases:

```bash
ARCH="$(uname -m)"
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
LATEST=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${RELEASE_URL}/latest))

curl -L "${RELEASE_URL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz

sudo mv "release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" /usr/local/bin/firecracker
sudo mv "release-${LATEST}-${ARCH}/jailer-${LATEST}-${ARCH}" /usr/local/bin/jailer
rm -rf "release-${LATEST}-${ARCH}"
```

### 2. Configure System User & IP Forwarding

The Jailer drops privileges to a dedicated unprivileged user (`firecracker`):

```bash
# Create firecracker system user and group
sudo groupadd -g 982 firecracker 2>/dev/null || true
sudo useradd -u 997 -g 982 -M -s /usr/sbin/nologin firecracker 2>/dev/null || true

# Enable IPv4 forwarding for guest internet access
sudo sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward = 1" | sudo tee /etc/sysctl.d/99-ip-forward.conf
```

### 3. Install Project Dependencies & Kernel Artifact

```bash
git clone https://github.com/vivek1504/agent-sandbox.git
cd agent-sandbox
npm install

# Setup artifacts directory and download kernel
sudo mkdir -p /var/lib/agent-sandbox/artifacts
wget https://github.com/vivek1504/agent-sandbox/releases/download/Beta/vmlinux
sudo mv vmlinux /var/lib/agent-sandbox/artifacts/
sudo chown -R root:firecracker /var/lib/agent-sandbox/artifacts
sudo chmod 750 /var/lib/agent-sandbox/artifacts
```

### 4. Build Templates & Start the Server

```bash
# Compile once as your own user, so dist/ is not left root-owned
npm run build

# Build the base Node.js template snapshot
sudo ./templates/build.sh node

# Create an API key. Authentication is on by default, and the key store is
# root-owned, so this must run as root and with the server stopped.
sudo "$(command -v node)" dist/auth/cli.js create "local-dev"

# Start the server (requires root for Jailer and netns configuration)
sudo npm start
# Server listening on http://localhost:3000
```

> [!NOTE]
> `sudo npm start` fails with `npm: command not found` when Node.js is installed through nvm, fnm, or volta: sudo replaces `PATH` with `secure_path`, which excludes your home directory. Build as yourself, then start with an absolute interpreter:
>
> ```bash
> npm run build
> sudo "$(command -v node)" dist/server.js
> ```
>
> Pass configuration on that same command line — `sudo "$(command -v node)" --env-file=.env dist/server.js`, or inline as `sudo VM_DNS_MODE=allow "$(command -v node)" dist/server.js`.

### 5. Verify Installation

`/health` and `/ready` are unauthenticated; everything under `/exec` requires a key with the `exec` scope.

```bash
export KEY=sk_test_...   # printed by the create command in step 4

# Health probe
curl http://localhost:3000/health
# {"status":"ok",...}

# Confirm the template registry loaded
curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/exec/templates | jq

# Execute a command in a fresh microVM
curl -s -X POST http://localhost:3000/exec/test-session/execute \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "node", "args": ["-e", "console.log(process.version)"]}' | jq

# Release it
curl -s -X DELETE -H "Authorization: Bearer $KEY" http://localhost:3000/exec/test-session
```

If `/exec/templates` returns `Invalid API key`, the key is not in the store the running server loaded — see the key management section. If it returns an empty list, no template registered; start the server with `LOG_LEVEL=info` and look for `skipping invalid template directory`.

---

## Integration & SDKs

Agent Sandbox offers three integration surfaces: a typed TypeScript/JavaScript SDK, a Model Context Protocol (MCP) server for autonomous agents, and a direct REST API.

### TypeScript / JavaScript SDK

The official client SDK (`@agent-sandbox/sdk`) is zero-dependency and runs across Node.js 18+, Bun, and Deno.

```bash
npm install ./sdk/typescript
```

```ts
import { Sandbox } from "@agent-sandbox/sdk";

const sandbox = new Sandbox({
  baseUrl: "http://localhost:3000",
  headers: { Authorization: "Bearer sk_test_..." },
});

// Create a session backed by Python
const session = sandbox.create({ template: "python" });

// Run code directly
const result = await session.runCode("print('Hello from isolated microVM!')");
console.log(result.output[0].data);

// Stream command output in real time
for await (const chunk of session.execStream("pip", { args: ["install", "requests"] })) {
  if (chunk.type === "stream") process.stdout.write(chunk.data!);
}

// Write and read files inside the session workspace
await session.writeFile("script.py", 'print("File execution works")');
const { content } = await session.readFile("script.py");

// Destroy the session and reclaim microVM resources
await session.destroy();
```

### Model Context Protocol (MCP)

Connect Claude Desktop, Cursor, or custom MCP-compatible AI agents directly to Agent Sandbox.

#### Stdio Configuration

Add to your MCP client configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-sandbox": {
      "command": "node",
      "args": ["/path/to/agent-sandbox/dist/mcp/stdio.js"],
      "env": {
        "FIRECRACKER_JAIL_BASE": "/var/lib/agent-sandbox/jailer",
        "FIRECRACKER_ARTIFACTS_DIR": "/var/lib/agent-sandbox/artifacts"
      }
    }
  }
}
```

#### MCP Tools Reference

| Tool | Parameters | Description |
|---|---|---|
| `create_session` | `template?` | Provision a new isolated execution session. |
| `list_templates` | — | List available environment templates and installed runtimes. |
| `execute` | `sessionId`, `command`, `args?`, `cwd?`, `timeout?` | Execute a binary or command inside the VM. |
| `write_file` | `sessionId`, `path`, `content` | Write a file to `/workspace`. |
| `read_file` | `sessionId`, `path`, `encoding?` | Read a file from `/workspace`. `encoding: "base64"` returns the raw payload for binary files. |
| `list_files` | `sessionId`, `path?`, `recursive?` | List contents of the workspace. |
| `reset_session` | `sessionId` | Immediately destroy the session and release resources. |

### REST API

The HTTP server exposes JSON endpoints under `/exec`:

```bash
# List available environment templates
curl -H "Authorization: Bearer sk_test_..." http://localhost:3000/exec/templates

# Execute command (buffered JSON response)
curl -X POST http://localhost:3000/exec/session-1/execute \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{"template": "node", "command": "node", "args": ["-e", "console.log(1+1)"]}'

# Execute command with streaming NDJSON output
curl -X POST http://localhost:3000/exec/session-1/execute \
  -H "Authorization: Bearer sk_test_..." \
  -H "Accept: application/x-ndjson" \
  -H "Content-Type: application/json" \
  -d '{"command": "npm", "args": ["install", "express"]}'

# Write a file to /workspace (accepts an optional template, like execute)
curl -X POST http://localhost:3000/exec/session-1/write \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{"path": "hello.txt", "content": "Hello World", "template": "node"}'

# Read a file from /workspace (utf8 by default)
curl -H "Authorization: Bearer sk_test_..." \
  "http://localhost:3000/exec/session-1/read?path=hello.txt"

# Read a binary file (screenshot, archive) without corrupting it
curl -H "Authorization: Bearer sk_test_..." \
  "http://localhost:3000/exec/session-1/read?path=screenshot.png&encoding=base64"

# List files in /workspace
curl -H "Authorization: Bearer sk_test_..." \
  "http://localhost:3000/exec/session-1/files?recursive=true"

# Execute with a caller-chosen id, then stop it from another shell
curl -X POST http://localhost:3000/exec/session-1/execute \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{"command": "sleep", "args": ["100"], "messageId": "run-abcdef12"}'

curl -X POST http://localhost:3000/exec/session-1/cancel \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{"messageId": "run-abcdef12"}'   # 202; the execute call returns signal: SIGTERM

# Terminate session
curl -X DELETE -H "Authorization: Bearer sk_test_..." \
  http://localhost:3000/exec/session-1
```

#### Cancelling a running command

`execute` accepts an optional `messageId` (8–64 characters of `[A-Za-z0-9_-]`). It comes back in the JSON response, and in NDJSON mode it is announced up front as the first frame — `{"type":"started","messageId":"…"}` — so a streaming client knows what to cancel before the command finishes:

```
{"type":"started","messageId":"run-abcdef12"}
{"type":"stream","stream":"stdout","data":"…"}
{"type":"result","exitCode":0,"duration":1234}
```

`POST /exec/:id/cancel` answers **202** as soon as the guest has been told to stop: the runtime sends `SIGTERM` to the process group, then `SIGKILL` after 5 seconds. The outcome shows up on the original `execute` call (`"signal": "SIGTERM"`), not on the cancel. Cancelling a command that has already finished is harmless. The endpoint never provisions a VM — a session with no live VM answers **404**.

#### Watching a desktop session (`GET /exec/:id/vnc`)

`desktop` sessions expose their X display as a WebSocket carrying raw RFB:

```bash
# Bearer header only — an access_token query parameter is deliberately not accepted
wscat -H "Authorization: Bearer sk_test_..." \
  --connect "ws://localhost:3000/exec/desk-1/vnc?template=desktop"
# < RFB 003.008
```

**A browser cannot connect to this endpoint directly.** The `WebSocket` API
cannot set request headers, and this route reads the `Authorization` header
only: a token in a URL is written to the access log, kept in browser history and
sent on in `Referer`, so `?access_token=` is refused by design. Anything that
can set headers — `wscat`, a Node or Python client, a server-side proxy — works
as shown above.

To watch a desktop in a browser, run [`tools/novnc-viewer`](tools/novnc-viewer),
which holds the key and adds the header on the browser's behalf:

```bash
cd tools/novnc-viewer && npm install
SANDBOX_KEY=sk_test_... npm start          # http://127.0.0.1:6080
```

The handshake is the usual one: `exec` scope, session ownership, and lazy VM provisioning through the same path as `/execute`, so the first connection to a fresh session id boots the desktop. Failures answer before the upgrade — **401**/**403** on auth, **429** past `VNC_MAX_CONNECTIONS_PER_SESSION`, **502** when the guest has no VNC listener (usually: not a `desktop` template), and a plain `GET` without an upgrade gets **426**. While a viewer is attached the session is kept alive against the idle reaper, and a tab that dies without closing the socket is dropped by ping/pong liveness rather than pinning the VM's memory.

> [!IMPORTANT]
> **A session's template is fixed by the first request that touches it.** Whichever call provisions the microVM — commonly `write`, not `execute` — determines the environment, and `template` on later requests against a live session is ignored. Writing a file and then executing with `"template": "browser"` runs on whatever the write created. Pass `template` on the first call, or use a fresh session id.

> [!NOTE]
> `read` decodes to UTF-8 by default, which corrupts binary files. Pass `encoding=base64` for anything that is not text; the response carries the guest's base64 payload untouched and an `encoding` field saying which you got. The SDK equivalent is `session.readFile(path, { encoding: "base64" })`, and the MCP `read_file` tool takes the same `encoding` argument.

### Authentication & API Key Management

Agent Sandbox includes a built-in scoped API key manager with per-key rate limiting.

> [!NOTE]
> In accordance with OWASP security practices, API keys are accepted exclusively via HTTP headers (`Authorization: Bearer <key>` or `X-API-Key: <key>`). Query-string authentication is rejected to prevent credentials leaking into access logs.

Manage keys via the CLI. Keys are stored at `AUTH_KEYS_PATH` (default `/var/lib/agent-sandbox/keys.json`), which is root-owned, so key creation must run as root:

```bash
npm run build
sudo "$(command -v node)" dist/auth/cli.js create "agent-key"
```

> [!WARNING]
> Running `npm run keys create` as an unprivileged user appears to succeed and prints a key, but the write silently fails: `saveKeys` catches the permission error and logs it at `warn`, which is suppressed by the default `silent` log level. Always create keys as root, then confirm with `npm run keys list`.

> [!IMPORTANT]
> Stop the server before creating keys, and restart it afterwards. The key store is loaded into memory once per process and never re-read, so a running server will reject keys created after it started. It also periodically persists its own in-memory copy when authenticated requests arrive, which can overwrite keys added by another process in the meantime.

Other operations:

```bash
# Generate a key with 'exec' scope
npm run keys create "agent-key"

# Generate an admin key with rate limiting (100 req/min)
npm run keys create "admin-key" --scopes exec,admin,metrics --rate-limit 100

# List, rotate, or revoke keys
npm run keys list
npm run keys rotate <key-id>
npm run keys revoke <key-id>
```

---

## Security Model

Agent Sandbox employs defense-in-depth isolation across compute, process, filesystem, and network layers:

<p align="center">
  <img width="100%" alt="Defense-in-Depth Security Model Diagram" src="https://github.com/user-attachments/assets/9e8ec908-c36e-42f3-97a2-a04ad94ddb7b" />
</p>

<details>
<summary>View Trust Boundary Diagram</summary>

```text
┌─────────────────────────────────────────────────────────────────┐
│ TRUSTED: Host Infrastructure & Linux Kernel                     │
│ • KVM hypervisor kernel module                                  │
│ • Express HTTP & MCP control plane                              │
│ • Linux network namespaces, host iptables, veth routing         │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Virtualization Boundary (KVM / virtio)
┌────────────────────────────────▼────────────────────────────────┐
│ SEMI-TRUSTED: Firecracker VMM Process                           │
│ • Jailer chroot (0o750 directory perms, unprivileged UID/GID)   │
│ • Restrictive seccomp syscall filter                            │
│ • Host cgroups v2 limits (pids.max=256, memory max, CPU quota)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ vsock IPC / Isolated Netns
┌────────────────────────────────▼────────────────────────────────┐
│ UNTRUSTED: MicroVM Guest & Executed Agent Code                  │
│ • Guest Linux kernel & arbitrary user processes                 │
│ • /workspace (isolated 512MB tmpfs RAM disk)                    │
│ • Network traffic constrained by per-namespace egress chains    │
└─────────────────────────────────────────────────────────────────┘
```
</details>

### Threat Mitigations

| Threat Vector | Mitigation Strategy | Implementation |
|---|---|---|
| **Host Escape** | Hardware virtualization + Jailer confinement | KVM hypervisor boundary, unprivileged UID/GID, chroot confinement, default seccomp profile |
| **Fork Bombs & DoS** | Kernel cgroup resource limits | `pids.max=256` enforced via cgroups v2/v1 per microVM slice |
| **Cloud Metadata Theft** | IMDS endpoint blocking | `169.254.169.254/32` dropped at both per-VM namespace egress and host `FORWARD` chains |
| **Host Port Scanning** | Host-level firewall isolation | `iptables -I INPUT -s 10.0.0.0/16 -j DROP` explicitly blocks guest access to host daemon ports |
| **Inter-Tenant Snooping** | Cross-VM packet isolation | `FORWARD -s 10.0.0.0/16 -d 10.0.0.0/16 -j DROP` prevents VMs from communicating with each other |
| **DNS Bypass & Exfiltration** | Transparent DNS redirection | `PREROUTING REDIRECT` forwards port 53 to local `dnsmasq`; unmanaged direct DNS egress is dropped |
| **Path Traversal** | Normalized path boundary validation | `isInsideWorkspace` strictly confines all file operations to `/workspace` |
| **IPv6 Leakage** | Complete IPv6 drop | `ip6tables -P DROP` enforced inside every network namespace |

---

## Performance & Benchmarks

An automated microsecond-accurate benchmark harness (`npm run bench`) profiles end-to-end performance across all subsystems.

* **Test System**: Ubuntu 24.04 LTS (Linux 6.17), Intel Core i5-11400H @ 2.70GHz, 6 Cores / 12 Threads, 8GB RAM, KVM enabled.

### 1. VM Lifecycle (Cold Start)

| Phase | Min | p50 (Median) | Mean | p95 | p99 |
|:---|---:|---:|---:|---:|---:|
| **Snapshot Restore** | 2.21ms | **2.59ms** | 2.77ms | 3.77ms | 3.77ms |
| Network Setup (netns + veth + iptables) | 50.8ms | 55.3ms | 58.8ms | 75.9ms | 75.9ms |
| Jailer & Socket Preparation | 9.20ms | 15.20ms | 14.90ms | 20.26ms | 20.26ms |
| Guest Vsock Handshake | 14.17ms | 15.30ms | 15.10ms | 15.50ms | 15.50ms |
| **Total Cold Start** | **83.1ms** | **90.6ms** | **91.8ms** | **104.8ms** | **104.8ms** |
| Warm Command RTT | 1.38ms | **1.48ms** | 2.29ms | 9.42ms | 9.42ms |

> [!TIP]
> Restoring the Firecracker microVM snapshot takes only **~2.6ms**. Over 60% of cold-start latency is dedicated to provisioning the isolated Linux network namespace (~55ms).

### 2. Concurrency Scaling

| Concurrency Tier | Min | p50 (Median) | Mean | p95 |
|:---|---:|---:|---:|---:|
| **1 Concurrent VM** | 82.2ms | 98.1ms | 97.4ms | 109.5ms |
| **5 Concurrent VMs** | 198.3ms | 209.5ms | 217.9ms | 246.1ms |
| **10 Concurrent VMs** | 372.8ms | 401.4ms | 411.8ms | 469.0ms |

### 3. Cleanup & Teardown Latency

| Operation | p50 (Median) | Mean | p95 |
|:---|---:|---:|---:|
| Process Termination (`SIGKILL`) | 11.8µs | 12.6µs | 19.4µs |
| Jail Directory Teardown (`rm -rf`) | 0.43ms | 0.48ms | 0.71ms |
| Network Namespace Deletion | 27.8ms | 25.7ms | 39.0ms |
| **Total Cleanup** | **7.53ms** | **7.78ms** | **8.45ms** |

---

## Configuration

Configure Agent Sandbox through environment variables. The server reads `process.env` directly and does **not** load `.env` on its own — `example.env` is a reference to copy from. To load a file, pass Node's `--env-file` flag: `node --env-file=.env dist/server.js`.

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port. |
| `LOG_LEVEL` | `silent` | Structured logger level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). Logging is off unless set; raise it to `info` or `debug` to diagnose startup and VM issues. |
| `AUTH_ENABLED` | `true` | Enforce API key authentication. |
| `AUTH_KEYS_PATH` | `/var/lib/agent-sandbox/keys.json` | Persistent storage path for API keys. |
| `AUTH_KEY_PREFIX` | `sk_test_` | Prefix assigned to newly generated API keys. |
| `FIRECRACKER_BIN` | `/usr/local/bin/firecracker` | Path to the Firecracker binary. |
| `FIRECRACKER_JAILER_BIN` | `/usr/local/bin/jailer` | Path to the Jailer binary. |
| `FIRECRACKER_JAIL_BASE` | `/var/lib/agent-sandbox/jailer` | Base directory for Jailer chroots. |
| `FIRECRACKER_ARTIFACTS_DIR` | `/var/lib/agent-sandbox/artifacts` | Directory storing kernel, snapshot, and template files. |
| `FIRECRACKER_UID` | `997` | Linux UID for the Firecracker Jailer process. |
| `FIRECRACKER_GID` | `982` | Linux GID for the Firecracker Jailer process. |
| `VM_VCPU_COUNT` | `1` | Guest vCPU count. |
| `VM_MEM_SIZE_MIB` | `128` | Guest RAM in MiB (must match snapshot configuration). |
| `VM_CPU_QUOTA_US` | `50000` | Cgroups v2 CPU bandwidth quota in microseconds. |
| `VM_CPU_PERIOD_US` | `100000` | Cgroups v2 CPU bandwidth period in microseconds. |
| `VM_MEMORY_LIMIT_BYTES` | `134217728` | Host-side cgroup memory limit (128 MiB). |
| `VM_PIDS_LIMIT` | `256` | Maximum process count inside the jail cgroup (fork-bomb protection). |
| *(per-template)* | — | A template may override any of the `VM_*` resource values above via the `resources` object in its `template.json`, written at build time. Template values take precedence over the server environment. |
| `VM_NOFILE_LIMIT` | `1024` | Maximum file descriptors per microVM process. |
| `STRICT_PERMISSIONS` | `false` | Fail fast on chmod/chown errors (automatically enabled in production). |
| `VM_DNS_MODE` | `none` | DNS filtering mode (`none`, `allow`, `deny`). |
| `VM_DNS_DOMAINS` | `""` | Comma-separated domain filter list (e.g. `*.npmjs.org,github.com`). |
| `VM_DNS_UPSTREAM` | `8.8.8.8,1.1.1.1` | Upstream DNS resolvers. |
| `VM_DEST_MODE` | `none` | Egress IP/Port filtering mode (`none`, `allow`, `deny`). |
| `VM_DEST_RULES` | `""` | Destination CIDR rules (e.g. `169.254.169.254/32,10.0.0.0/8:443/tcp`). |
| `VM_BW_ENABLED` | `false` | Enable TC network bandwidth throttling. |
| `VM_BW_RATE_KBIT` | `10240` | TC bandwidth limit in kbit/s (10240 = 10 Mbit/s). |
| `VM_BW_BURST_KBIT` | `1024` | TC burst allowance in kbit. |
| `VNC_MAX_CONNECTIONS_PER_SESSION` | `2` | Concurrent `GET /exec/:id/vnc` bridges allowed per session; further upgrades get 429. |
| `VNC_MAX_DURATION_MS` | `14400000` | Hard cap on a single VNC connection (4 hours), after which the socket is closed. |

---

## Observability

Agent Sandbox includes production-grade observability out of the box:

* **Prometheus Metrics** (`GET /metrics`): Tracks `active_vm_count`, `vm_creation_time`, `exec_sessions_active`, `exec_session_duration_seconds`, `exec_message_duration_seconds`, `vsock_connection_time`, `vnc_connections_active`, `vnc_connections_total{result}`, and egress policies.
* **Liveness & Readiness Probes**:
  * `GET /health` — Verifies process uptime.
  * `GET /ready` — Evaluates node readiness and host memory headroom.

---

## Testing & Benchmarks

```bash
# Run unit & integration test suites (Vitest)
npm test

# Run Firecracker microVM end-to-end integration test (requires KVM + root)
sudo npm run test:e2e

# Run test suite with coverage report
npm run test:coverage

# Run microsecond benchmark harness
sudo npm run bench

# Run specific benchmark suite (e.g. lifecycle with 20 iterations)
sudo npm run bench -- -s vm -i 20
```
