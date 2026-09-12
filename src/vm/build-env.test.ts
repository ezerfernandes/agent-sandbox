import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_SH = path.join(REPO_ROOT, "templates/build.sh");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-env-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Lift the build.env sourcing block out of the real build.sh so these cases run
 * against the shipped code. build.sh itself needs root, Docker and KVM.
 */
function sourcingBlock(scriptDir: string, template: string): string {
  const source = fs.readFileSync(BUILD_SH, "utf8");
  const start = source.indexOf('if [ -f "${SCRIPT_DIR}/${TEMPLATE}/build.env" ]; then');
  expect(start, "build.env block missing from build.sh").toBeGreaterThan(-1);
  const end = source.indexOf("\nfi", start);
  const block = source.slice(start, end + 3);
  return [
    "set -euo pipefail",
    `SCRIPT_DIR=${JSON.stringify(scriptDir)}`,
    `TEMPLATE=${JSON.stringify(template)}`,
    block,
    'echo "ROOTFS_SIZE=${ROOTFS_SIZE:-unset}"',
    'echo "VM_MEM_SIZE_MIB=${VM_MEM_SIZE_MIB:-unset}"',
    'echo "VM_VCPU_COUNT=${VM_VCPU_COUNT:-unset}"',
  ].join("\n");
}

function runSourcing(
  scriptDir: string,
  template: string,
  env: Record<string, string> = {},
): Record<string, string> {
  const out = execFileSync("bash", ["-c", sourcingBlock(scriptDir, template)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("templates/build.sh build.env support", () => {
  it("is a valid bash script", () => {
    expect(() =>
      execFileSync("bash", ["-n", BUILD_SH], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("exports the values a template's build.env declares", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "demo"));
    fs.writeFileSync(
      path.join(dir, "demo/build.env"),
      ': "${ROOTFS_SIZE:=2048}"\n: "${VM_MEM_SIZE_MIB:=1536}"\n',
    );

    const vars = runSourcing(dir, "demo");

    expect(vars.ROOTFS_SIZE).toBe("2048");
    expect(vars.VM_MEM_SIZE_MIB).toBe("1536");
  });

  it("lets an explicitly exported value win over the template default", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "demo"));
    fs.writeFileSync(path.join(dir, "demo/build.env"), ': "${VM_MEM_SIZE_MIB:=1536}"\n');

    const vars = runSourcing(dir, "demo", { VM_MEM_SIZE_MIB: "4096" });

    expect(vars.VM_MEM_SIZE_MIB).toBe("4096");
  });

  it("is a no-op for a template with no build.env", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "plain"));

    const vars = runSourcing(dir, "plain");

    expect(vars.ROOTFS_SIZE).toBe("unset");
  });

  it("ships browser sizing that no longer depends on a hand-typed env list", () => {
    const vars = runSourcing(path.join(REPO_ROOT, "templates"), "browser");

    expect(vars.ROOTFS_SIZE).toBe("2048");
    expect(vars.VM_MEM_SIZE_MIB).toBe("1024");
    expect(vars.VM_VCPU_COUNT).toBe("2");
  });
});
