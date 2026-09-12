import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const START_SH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../minimal-rootfs/start.sh",
);

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-hooks-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Lift the boot-hook block out of the real start.sh and point it at a temp
 * directory, so these cases exercise the shipped snippet rather than a copy of
 * it. The guest itself cannot be booted from a unit test.
 */
function bootHookScript(bootDir: string): string {
  const source = fs.readFileSync(START_SH, "utf8");
  const start = source.indexOf("if [ -d /etc/sandbox/boot.d ]; then");
  expect(start, "boot.d block missing from start.sh").toBeGreaterThan(-1);
  const end = source.indexOf("\nfi", start);
  const block = source.slice(start, end + 3);
  return `set -e\n${block.replaceAll("/etc/sandbox/boot.d", bootDir)}\necho READY\n`;
}

function runBootHooks(bootDir: string): string {
  return execFileSync("sh", ["-c", bootHookScript(bootDir)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("start.sh boot hooks", () => {
  it("is a valid POSIX shell script", () => {
    expect(() =>
      execFileSync("sh", ["-n", START_SH], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("runs the hooks before signalling READY", () => {
    const source = fs.readFileSync(START_SH, "utf8");
    expect(source.indexOf("/etc/sandbox/boot.d")).toBeLessThan(
      source.indexOf('echo "READY"'),
    );
  });

  it("brings loopback up before running the hooks", () => {
    const source = fs.readFileSync(START_SH, "utf8");

    // A guest from `docker export` boots with lo DOWN and no address, so
    // anything binding localhost fails with EADDRNOTAVAIL. The desktop
    // template's `Xvnc -localhost` died exactly this way on real Firecracker:
    // "createTcpListeners: no addresses available". Hooks start daemons that
    // bind localhost, so this has to happen first.
    expect(source).toMatch(/ip link set lo up/);
    expect(source).toMatch(/ip addr add 127\.0\.0\.1\/8 dev lo/);
    expect(source.indexOf("ip link set lo up")).toBeLessThan(
      source.indexOf("/etc/sandbox/boot.d"),
    );
  });

  it("runs every *.sh hook in lexical order", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "20-second.sh"), "echo second\n");
    fs.writeFileSync(path.join(dir, "10-first.sh"), "echo first\n");

    const out = runBootHooks(dir);

    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
    expect(out).toContain("READY");
  });

  it("keeps booting when a hook fails, despite set -e", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "10-broken.sh"), "exit 3\n");
    fs.writeFileSync(path.join(dir, "20-ok.sh"), "echo later-hook-ran\n");

    const out = runBootHooks(dir);

    expect(out).toContain("boot hook failed");
    expect(out).toContain("later-hook-ran");
    expect(out).toContain("READY");
  });

  it("still reaches READY when no hooks are installed", () => {
    const out = runBootHooks(tmpDir());
    expect(out).toContain("READY");
  });

  it("ignores an absent boot.d directory", () => {
    const out = runBootHooks(path.join(tmpDir(), "missing"));
    expect(out).toContain("READY");
  });

  it("ignores non-.sh files in boot.d", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "notes.txt"), "echo should-not-run\n");

    const out = runBootHooks(dir);

    expect(out).not.toContain("should-not-run");
    expect(out).toContain("READY");
  });
});
