import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "templates/desktop");
const BIN_DIR = path.join(TEMPLATE_DIR, "bin");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-tpl-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop template", () => {
  it("ships an executable boot hook and launcher scripts", () => {
    const files = [
      "boot.d/10-desktop.sh",
      "bin/desktop-launch",
      "bin/desktop-chromium",
      "bin/desktop-screenshot",
    ];

    for (const file of files) {
      const full = path.join(TEMPLATE_DIR, file);
      expect(fs.existsSync(full), `${file} missing`).toBe(true);
      expect(() => execFileSync("sh", ["-n", full], { stdio: "pipe" })).not.toThrow();
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(full).mode & 0o111, `${file} not executable`).toBeGreaterThan(0);
    }
  });

  it("installs the hook where start.sh looks for it", () => {
    const dockerfile = fs.readFileSync(path.join(TEMPLATE_DIR, "Dockerfile"), "utf8");
    const startSh = fs.readFileSync(path.join(REPO_ROOT, "minimal-rootfs/start.sh"), "utf8");

    expect(dockerfile).toContain("COPY templates/desktop/boot.d/ /etc/sandbox/boot.d/");
    expect(startSh).toContain("/etc/sandbox/boot.d");
  });

  it("bridges the guest RFB port to the vsock port the host connects to", () => {
    const hook = fs.readFileSync(path.join(TEMPLATE_DIR, "boot.d/10-desktop.sh"), "utf8");
    const route = fs.readFileSync(path.join(REPO_ROOT, "src/routes/vnc.ts"), "utf8");

    expect(hook).toContain("VSOCK-LISTEN:5900");
    expect(hook).toContain("TCP:127.0.0.1:5901");
    expect(route).toContain("GUEST_VNC_PORT = 5900");
  });

  it("waits for the display to answer before returning to start.sh", () => {
    const hook = fs.readFileSync(path.join(TEMPLATE_DIR, "boot.d/10-desktop.sh"), "utf8");

    // READY freezes the snapshot; a hook that returns before Xvnc serves bakes
    // a half-started X session into every restored VM.
    expect(hook).toMatch(/until xdpyinfo/);
    expect(hook).toMatch(/until nc -z 127\.0\.0\.1 5901/);
  });

  it("keeps every boot-hook write on tmpfs (the guest root is mounted read-only)", () => {
    const hook = fs.readFileSync(path.join(TEMPLATE_DIR, "boot.d/10-desktop.sh"), "utf8");

    // create_snapshot.ts mounts the root filesystem read-only and start.sh never
    // remounts it, so `mkdir -p /root/.vnc` under `set -e` killed the hook before
    // Xvnc started — and start.sh swallowed it, baking a desktop with no X
    // session into the snapshot.
    const code = hook
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(code).not.toMatch(/\/root/);
    expect(code).toMatch(/HOME:=\/tmp\//);
    for (const target of code.matchAll(/^\s*mkdir -p (.+)$/gm)) {
      expect(target[1], "boot hook writes outside tmpfs").not.toMatch(/(^| )\/(?!tmp)/);
    }
  });

  it("fails the boot hook when the vsock bridge dies instead of reporting success", () => {
    const hook = fs.readFileSync(path.join(TEMPLATE_DIR, "boot.d/10-desktop.sh"), "utf8");

    // The RFB probe only proves Xvnc is up. A socat that dies on its first
    // syscall is invisible until a viewer gets a 502, so its liveness is sampled
    // via /proc — `kill -0` answers 0 for an unreaped zombie.
    expect(hook).toContain("SOCAT_PID=$!");
    expect(hook).toMatch(/State:\.\*Z/);
    expect(hook).toContain("vsock bridge (socat) died on start");
  });

  it("puts HOME and the XDG dirs on tmpfs for everything the runtime spawns", () => {
    const dockerfile = fs.readFileSync(path.join(TEMPLATE_DIR, "Dockerfile"), "utf8");
    const launch = fs.readFileSync(path.join(BIN_DIR, "desktop-launch"), "utf8");

    // With HOME=/root on the read-only guest root, Chromium's crashpad handler
    // fails ("--database is required") and the browser dies with SIGTRAP before
    // a window ever appears. Verified in a read-only container: exit 133 with
    // HOME=/root, exit 0 with HOME on tmpfs.
    expect(dockerfile).toContain("'HOME=/tmp/desktop-home'");
    expect(dockerfile).toContain("'XDG_CONFIG_HOME=/tmp/desktop-home/.config'");
    expect(dockerfile).toContain("'XDG_CACHE_HOME=/tmp/desktop-home/.cache'");
    // Defence in depth: the launcher sets them too, for anything that reaches
    // the guest without /etc/environment having been sourced.
    expect(launch).toMatch(/HOME:=\/tmp\//);
    expect(launch).toContain("export DISPLAY HOME XDG_CONFIG_HOME XDG_CACHE_HOME");
  });

  it("returns from desktop-launch without waiting for the program to exit", () => {
    const started = Date.now();
    const out = execFileSync("sh", [path.join(BIN_DIR, "desktop-launch"), "sleep", "5"], {
      encoding: "utf8",
      timeout: 4000,
    });

    // The guest runtime waits on stdio, so a launcher that blocks would hang
    // the /execute call for the whole life of the GUI program.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toContain("launched: sleep 5");
  });

  it("rejects an empty desktop-launch invocation", () => {
    expect(() =>
      execFileSync("sh", [path.join(BIN_DIR, "desktop-launch")], { stdio: "pipe" }),
    ).toThrow();
  });

  it("builds Chromium flags that suit a GPU-less read-only guest", () => {
    const stubDir = tmpDir();
    const capture = path.join(stubDir, "args.txt");
    fs.writeFileSync(
      path.join(stubDir, "desktop-launch"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${capture}\n`,
      { mode: 0o755 },
    );

    execFileSync("sh", [path.join(BIN_DIR, "desktop-chromium"), "https://example.com"], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        DESKTOP_GEOMETRY: "1024x768",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(capture, "utf8").trim().split("\n");
    expect(args[0]).toBe("chromium-browser");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-gpu");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--user-data-dir=/tmp/chromium-profile");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--window-size=1024,768");
    expect(args).toContain("https://example.com");
  });

  it("defaults the screenshot to a workspace path the host can read back", () => {
    const script = fs.readFileSync(path.join(BIN_DIR, "desktop-screenshot"), "utf8");

    expect(script).toContain("/workspace/screenshot.png");
    expect(script).toContain("scrot -o");
  });

  it("declares sizing that Chromium under X can actually survive", () => {
    const buildEnv = fs.readFileSync(path.join(TEMPLATE_DIR, "build.env"), "utf8");
    const out = execFileSync("bash", ["-c", `set -a; . ${path.join(TEMPLATE_DIR, "build.env")}; echo "$VM_MEM_SIZE_MIB $ROOTFS_SIZE $VM_VCPU_COUNT"`], {
      encoding: "utf8",
    });

    expect(buildEnv).toContain(':=');
    expect(out.trim()).toBe("1536 2048 2");
  });
});
