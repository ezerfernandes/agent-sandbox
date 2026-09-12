# Deploying agent-sandbox on a VPS

Everything here provisions a **single host running the sandbox alone** — no UI, no
external database, nothing else to stand up. Clone the repo on the machine, run
one script, create a key, start the service.

```bash
git clone https://github.com/vivek1504/agent-sandbox.git
cd agent-sandbox
sudo ./deploy/provision.sh --install-service --templates "node"
sudo ./deploy/create-key.sh my-key exec,admin,metrics
sudo systemctl start agent-sandbox
```

The rest of this document explains what that does, what it deliberately does
not do, and how to choose a host that can run it at all.

---

## 1. The host requirement that rules out most VPS plans

Firecracker needs `/dev/kvm`. That is hardware virtualisation exposed to the
machine you are renting, and most cheap VPS plans are themselves guests that
cannot nest another hypervisor.

| Provider | What works |
|---|---|
| **AWS** | Bare metal only (`c5.metal`, `m5.metal`, `i3.metal`, …). KVM is **not** exposed on ordinary Nitro instances, and there is no flag to change that. Expect ~$4/hour on-demand. |
| **Hetzner, OVH, Vultr, Equinix** | Dedicated/bare-metal servers work. An order of magnitude cheaper than AWS metal for the same capability. |
| **Hetzner Cloud, DigitalOcean, Linode, Vultr (cloud plans)** | Generally no nested virtualisation. Some providers enable it on request — ask before paying. |
| **GCP** | Nested virtualisation is supported on most VM types, so ordinary instances work. Enable it on the image/instance. |

Check before anything else:

```bash
ls -l /dev/kvm && echo OK
```

No `/dev/kvm`, no sandbox. `provision.sh` refuses to continue without it unless
you pass `--skip-kvm-check`, which exists only for staging a host you will not
run VMs on.

**Sizing.** Each template costs disk twice — a rootfs image plus a memory
snapshot equal to the template's guest RAM. Roughly 1.1 GB for `node`, ~3 GB for
a browser-class template, plus ~3 GB of Docker images during builds. 60 GB is
comfortable for one or two templates, 100 GB if you build several. For RAM,
budget the template's cgroup ceiling per concurrent session — a 128 MiB `node`
VM is nothing, a 1.5-2 GiB browser VM is not.

---

## 2. What `provision.sh` does

Idempotent and re-runnable; every step checks for its own result first.

1. Verifies `/dev/kvm`.
2. Installs packages: Docker (template builds), `dnsmasq-base`, `iptables`,
   `e2fsprogs`, Node.js 22 if absent. Disables any system-wide `dnsmasq`
   service — the sandbox spawns its own per microVM, and a resolver holding
   port 53 collides with them.
3. Installs a **pinned** `firecracker` and `jailer` into `/usr/local/bin`,
   verified against a hardcoded sha256 before extraction.
4. Creates the `firecracker` system user and group at **uid 997 / gid 982** —
   the values `src/vm/jailer.ts` passes to the jailer. Override them in both
   places or neither.
5. Enables `net.ipv4.ip_forward` persistently (guest internet access).
6. Creates `/var/lib/agent-sandbox/artifacts`, downloads the guest kernel and
   verifies its sha256 before installing it, sets `root:firecracker 0750`.
7. `npm ci && npm run build` as the repo's owner, not as root, so `dist/` does
   not end up root-owned. Dependencies are installed on **every** run: skipping
   when `node_modules/` exists leaves the tree stale after a pull that adds a
   dependency, which is exactly when the re-run was needed.
8. Copies `sandbox.env.example` to `/etc/agent-sandbox/sandbox.env` — **existing
   files are never overwritten**, so re-running is safe.
9. Optionally builds templates (`--templates "node browser"`).
10. Optionally installs and enables the systemd unit (`--install-service`),
    without starting it — review the env file first.

It does **not** create API keys, start the service, or touch a firewall.

### Flags

| Flag | Effect |
|---|---|
| `--templates "node browser"` | Build these templates (several minutes each) |
| `--install-service` | Install + enable the systemd unit |
| `--skip-packages` | Assume packages are already present |
| `--skip-kvm-check` | Stage a host without `/dev/kvm` |
| `--skip-build` | Re-provision without re-running `npm ci` / `npm run build` |

### Pinned downloads

Three things are fetched and then trusted with root: the firecracker and jailer
binaries, and the guest kernel every microVM boots. All three are pinned and
checksum-verified, and a mismatch aborts the run without installing anything.

| Variable | Default | Use |
|---|---|---|
| `FC_VERSION` | `v1.17.0` | Firecracker release to install |
| `FC_SHA256` | per-arch, hardcoded | Override for an architecture not listed |
| `KERNEL_URL` | project release asset | Point at your own kernel |
| `KERNEL_SHA256` | digest of the default kernel | **Set this whenever you set `KERNEL_URL`**; empty skips verification (warned) |
| `NODE_MAJOR_WANTED` | `22` | Node.js major from NodeSource |

To move to a newer Firecracker, bump `FC_VERSION` and replace both digests in
`provision.sh` with the ones from that release's own
`firecracker-<version>-<arch>.tgz.sha256.txt`.

Node.js is installed by adding the NodeSource signing key and apt source
directly rather than by piping their `setup_22.x` script into `bash` as root:
apt then verifies a signature on every package, and no vendor code runs here.

---

## 3. Configuration

`/etc/agent-sandbox/sandbox.env` is read by the systemd unit. Full variable
reference lives in the root README; three settings deserve attention on a fresh
host.

**`LOG_LEVEL=info`.** The application default is `silent`. A silent server
starts, binds, serves, and tells you nothing — including when template
registration fails at boot. The example file sets `info` for this reason.

**`VM_MAX_SLOTS=16`.** The application default of 254 is a network-slot limit,
not a memory-aware one. Set it to `(usable RAM) / (largest template's cgroup
ceiling)`.

**`VM_DEST_RULES=169.254.169.254/32` with `VM_DEST_MODE=deny`.** On any cloud
host, a guest that reaches the metadata endpoint can read the instance role's
credentials. On AWS, also enforce IMDSv2 (`HttpTokens=required`) at the instance
level.

Per-VM resource variables in this file are defaults for templates built
**without** a `build.env`. A template that ships one carries its limits in its
`template.json` and overrides these at restore.

---

## 4. Templates

```bash
sudo ./templates/build.sh node
```

Build them from the repo root, as root. Sizing comes from
`templates/<name>/build.env` where present, so there is no environment list to
type.

**Rebuilding any template rebuilds the shared base image**, which invalidates
every other template. Build all the ones you use in one sitting, and rebuild all
of them whenever `minimal-rootfs/start.sh` or `templates/base/Dockerfile`
changes — existing snapshots keep the old boot script.

If Node came from nvm/fnm/volta rather than apt, `sudo` hides it behind
`secure_path`. `build.sh` probes the usual locations; if it still cannot find
one, pass `NODE_BIN="$(command -v node)"`.

---

## 5. API keys

```bash
sudo ./deploy/create-key.sh my-key exec,admin,metrics
```

The store is read **once at process start**. A key created while the server runs
is invisible to it, and every request with that key answers 401 until a restart
— which reads like a bad key rather than a stale process. `create-key.sh` stops
the service, creates the key, and starts it again, restoring the service even if
creation fails.

The key is printed once; only its hash is stored. Scopes are `exec`, `admin`,
`metrics`.

`create-key.sh` reads `AUTH_KEYS_PATH`, `AUTH_KEY_PREFIX` and `PORT` out of
`/etc/agent-sandbox/sandbox.env` — the same `EnvironmentFile` the unit uses — and
prints the store it wrote to. The CLI and the server default that path
independently, so customising it in `sandbox.env` alone would have the CLI keep
writing to the default while the server read elsewhere: the new key then answers
401 forever, looking exactly like a bad key. Point `CONFIG_FILE` elsewhere if
your unit uses a different env file.

---

## 6. Reaching it from your workstation

The server speaks **plain HTTP** and authenticates with a bearer token. Exposing
port 3000 publicly puts that token on the wire in cleartext. Keep the port
closed and tunnel:

```bash
ssh -N -L 3000:localhost:3000 user@your-host

# then, locally
KEY=sk_live_...
curl -s -H "Authorization: Bearer $KEY" localhost:3000/exec/templates | jq '.templates[].name'

curl -s -X POST localhost:3000/exec/s1/execute \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"template":"node","command":"node","args":["-e","console.log(1+1)"]}'
```

If it genuinely must be reachable, put nginx or a load balancer with TLS in
front and keep 3000 bound to loopback behind it.

### Watching a desktop session

A browser cannot open `GET /exec/:id/vnc` itself — the `WebSocket` API cannot
set an `Authorization` header, and that route deliberately refuses a token in
the query string. Run the viewer on the sandbox host and tunnel to it:

```bash
cd tools/novnc-viewer && npm install
SANDBOX_KEY=sk_live_... npm start          # binds 127.0.0.1:6080

# from your workstation
ssh -N -L 6080:127.0.0.1:6080 user@your-host
```

Then open <http://localhost:6080>, enter a session id and connect. It needs a
`desktop`-class template built, or the VNC route answers 502.

The viewer has **no authentication of its own** and holds an API key, so anyone
who can reach its port drives every desktop session that key can reach. It binds
loopback for that reason — see [`tools/novnc-viewer/README.md`](../tools/novnc-viewer/README.md).

---

## 7. Operating it

```bash
sudo systemctl status agent-sandbox
sudo journalctl -u agent-sandbox -f
sudo systemctl restart agent-sandbox
```

`curl localhost:3000/health` for liveness, `/ready` for readiness, and
`/metrics` (needs the `metrics` scope) for Prometheus output covering VM counts,
creation time, session duration and vsock timings.

On `SIGTERM` the server drains active sessions before exiting; the unit allows
45s for that, since the application force-exits at 30s.

### Things that will cost you an hour each

- **A session is pinned to the template that created it.** Pass `template` on
  the first call for a session — commonly a `write`, not an `execute`. Passing
  it later against a live session does nothing, and the workload silently runs
  on the wrong VM.
- **Read binary files with `?encoding=base64`.** The default decodes to UTF-8
  and corrupts them.
- **Snapshot restore is IO-heavy.** If cold starts feel slow on network-backed
  storage, move `/var/lib/agent-sandbox` to local NVMe.
- **A stale template after a base-image change** boots with the old
  `start.sh`. Rebuild.
