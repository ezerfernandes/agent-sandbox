/**
 * The agent side of the console.
 *
 * "Agent" here means a program outside the microVM that drives it through the
 * sandbox's public API — the same position a real LLM-backed agent occupies.
 * These tasks are scripted rather than model-driven, so what you watch is the
 * sandbox's behaviour and not a model's: every step below is a real call to
 * /exec, and the desktop panel shows the guest reacting to it live.
 *
 * A step is:
 *   { title, detail?, run: async (ctx) => ({ output?, image?, note? }) }
 *
 * `ctx` gives a step the sandbox client and the session it is working in.
 */

/** Shell out in the guest. Commands are argv, so shell syntax needs sh -c. */
const sh = (script) => ({ command: "sh", args: ["-c", script] });

/**
 * Wait until `probe` prints something on stdout, or give up.
 *
 * Polling from the host rather than `sleep`ing a fixed time inside the guest:
 * a fixed sleep is either a stall or a flake, and the round trip is ~5ms.
 */
async function waitFor(ctx, probe, { attempts = 20, everyMs = 500, what }) {
  for (let i = 0; i < attempts; i++) {
    const r = await ctx.exec(sh(probe));
    if (r.stdout.trim()) return r.stdout.trim();
    await new Promise((res) => setTimeout(res, everyMs));
  }
  throw new Error(`timed out waiting for ${what ?? "condition"}`);
}

/** Grab the guest's screen and hand it back as a data URI for the UI. */
async function screenshot(ctx, label = "screen") {
  await ctx.exec(sh("desktop-screenshot /workspace/_shot.png >/dev/null 2>&1"));
  const file = await ctx.read("/workspace/_shot.png", "base64");
  return { image: `data:image/png;base64,${file.content}`, note: `${label} — ${file.size} bytes` };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * @param url      page to open
 * @param name     what to call it in the UI
 * @param expect   fragment the window title must contain before we call it loaded
 */
const browseTask = (url, name, expect) => ({
  id: `browse-${name}`,
  label: `Open ${name}`,
  template: "desktop",
  blurb: `Launches Chromium on the guest's X display, waits for the page to settle, then captures the screen.`,
  steps: [
    {
      title: "Close any window already open",
      detail: "`[c]hromium` so the pattern cannot match the shell running it; -x fails here because Linux truncates comm to 15 chars",
      run: async (ctx) => {
        const r = await ctx.exec(
          sh("pkill -f '[c]hromium-browser' 2>/dev/null; sleep 1; echo \"windows now: $(xdotool search --onlyvisible --name . 2>/dev/null | wc -l)\""),
        );
        return { output: r.stdout };
      },
    },
    {
      title: `Launch Chromium on ${url}`,
      detail: "desktop-chromium detaches with setsid, so this returns in milliseconds",
      run: async (ctx) => {
        const r = await ctx.exec(sh(`desktop-chromium ${JSON.stringify(url)} 2>&1 | head -2`));
        return { output: r.stdout || "(launched)" };
      },
    },
    {
      title: `Wait for a window titled like "${expect}"`,
      detail: "matched against the expected page, not merely any title — a stale window from a previous run would otherwise satisfy it instantly",
      run: async (ctx) => {
        const title = await waitFor(
          ctx,
          `xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null | grep -i ${JSON.stringify(expect)} | head -1`,
          { what: `a window titled like "${expect}"`, attempts: 40 },
        );
        return { output: title, note: "title matched the page we asked for" };
      },
    },
    {
      title: "Capture the screen",
      detail: "scrot inside the guest, read back over vsock as base64",
      run: async (ctx) => screenshot(ctx, "after load"),
    },
  ],
});

const TASKS = [
  browseTask("https://en.wikipedia.org/wiki/Firecracker_(software)", "the Firecracker article", "Firecracker"),
  browseTask("https://example.com", "example.com", "Example Domain"),

  {
    id: "scroll-and-shoot",
    label: "Scroll the page and re-capture",
    template: "desktop",
    blurb: "Sends real key events to the focused window with xdotool, proving the desktop is interactive and not a static image.",
    steps: [
      {
        title: "Focus the browser window",
        run: async (ctx) => {
          const r = await ctx.exec(sh("xdotool search --onlyvisible --name Chromium windowactivate %1 2>&1; echo focused"));
          return { output: r.stdout };
        },
      },
      {
        title: "Press Page Down five times",
        detail: "xdotool key — the same path a human's keystrokes take over VNC",
        run: async (ctx) => {
          const r = await ctx.exec(sh("for i in 1 2 3 4 5; do xdotool key Page_Down; sleep 0.4; done; echo 'sent 5 keys'"));
          return { output: r.stdout };
        },
      },
      { title: "Capture the scrolled screen", run: async (ctx) => screenshot(ctx, "after scrolling") },
    ],
  },

  {
    id: "prove-isolation",
    label: "Prove this is a separate machine",
    template: "desktop",
    blurb: "Reads the guest's kernel, memory ceiling, filesystem layout and process table. None of it is the host's.",
    steps: [
      {
        title: "Kernel and PID 1",
        detail: "a container would report the host kernel here",
        run: async (ctx) => {
          const r = await ctx.exec(sh("uname -sr; echo '--- pid 1:'; cat /proc/1/comm; echo '--- cpus:'; nproc"));
          return { output: r.stdout };
        },
      },
      {
        title: "Memory ceiling",
        detail: "the template's own cgroup limit, not the host's RAM",
        run: async (ctx) => {
          const r = await ctx.exec(sh("free -m | head -2"));
          return { output: r.stdout };
        },
      },
      {
        title: "Filesystem: read-only root, tmpfs workspace",
        run: async (ctx) => {
          const r = await ctx.exec(
            sh("mount | grep -E ' / | /workspace | /tmp ' | head -4; echo '--- write to /etc:'; touch /etc/nope 2>&1 || echo 'refused (root is read-only)'"),
          );
          return { output: r.stdout };
        },
      },
      {
        title: "Network: loopback plus one interface",
        detail: "busybox ip has no -br, so this parses the long form",
        run: async (ctx) => {
          const r = await ctx.exec(
            sh("ip addr 2>/dev/null | grep -E '^[0-9]+:|inet ' | sed 's/^ *//'; echo '--- listening:'; netstat -ltn 2>/dev/null | tail -n +3 | head -4"),
          );
          return { output: r.stdout, note: "5901 is Xvnc, bound to loopback — the only way in is the vsock bridge" };
        },
      },
    ],
  },

  {
    id: "write-and-run",
    label: "Write a file and run it",
    template: "desktop",
    blurb: "Pushes a script into the guest over the file API, runs it, and reads the result back — the loop an agent uses when it writes code.",
    steps: [
      {
        title: "Write /workspace/report.js into the guest",
        run: async (ctx) => {
          const src = [
            "const os = require('os');",
            "const report = {",
            "  kernel: os.release(),",
            "  totalMemMB: Math.round(os.totalmem() / 1024 / 1024),",
            "  cpus: os.cpus().length,",
            "  uptimeSec: Math.round(os.uptime()),",
            "};",
            "require('fs').writeFileSync('/workspace/report.json', JSON.stringify(report, null, 2));",
            "console.log(JSON.stringify(report, null, 2));",
          ].join("\n");
          await ctx.write("/workspace/report.js", src);
          return { output: `${src.split("\n").length} lines written` };
        },
      },
      {
        title: "Run it in the guest",
        run: async (ctx) => {
          const r = await ctx.exec({ command: "node", args: ["/workspace/report.js"] });
          return { output: r.stdout || r.stderr };
        },
      },
      {
        title: "Read the JSON it produced back out",
        run: async (ctx) => {
          const f = await ctx.read("/workspace/report.json", "utf8");
          return { output: f.content, note: `${f.size} bytes` };
        },
      },
    ],
  },

  {
    id: "headless-render",
    label: "Headless render (browser template)",
    template: "browser",
    blurb: "The browser template has no X server at all — Playwright renders offscreen and hands back a PNG. This is the shape you use in production, where nobody is watching.",
    steps: [
      {
        title: "Drive Chromium with Playwright",
        detail: "no display, no VNC — the desktop panel stays dark for this one",
        run: async (ctx) => {
          const script = `
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('https://example.com', { waitUntil: 'load' });
  console.log('title: ' + await p.title());
  await p.screenshot({ path: '/workspace/headless.png' });
  await b.close();
  console.log('rendered offscreen');
})();`.trim();
          await ctx.write("/workspace/render.js", script);
          const r = await ctx.exec({ command: "node", args: ["/workspace/render.js"] }, 120000);
          return { output: r.stdout || r.stderr };
        },
      },
      {
        title: "Read the PNG it never displayed",
        run: async (ctx) => {
          const f = await ctx.read("/workspace/headless.png", "base64");
          return { image: `data:image/png;base64,${f.content}`, note: `${f.size} bytes, rendered with no display attached` };
        },
      },
    ],
  },
];

export function listTasks() {
  return TASKS.map(({ id, label, template, blurb, steps }) => ({
    id,
    label,
    template,
    blurb,
    steps: steps.map((s) => ({ title: s.title, detail: s.detail ?? null })),
  }));
}

export function getTask(id) {
  return TASKS.find((t) => t.id === id);
}

/**
 * Run a task, reporting progress through `emit` as it goes rather than at the
 * end — the point of the console is watching the guest react while it happens.
 */
export async function runTask(task, ctx, emit) {
  emit({ type: "task-start", id: task.id, label: task.label, steps: task.steps.length });

  for (const [index, step] of task.steps.entries()) {
    emit({ type: "step-start", index, title: step.title, detail: step.detail ?? null });
    const started = Date.now();
    try {
      const result = (await step.run(ctx)) ?? {};
      emit({
        type: "step-done",
        index,
        ms: Date.now() - started,
        output: result.output ?? null,
        image: result.image ?? null,
        note: result.note ?? null,
      });
    } catch (err) {
      emit({ type: "step-failed", index, ms: Date.now() - started, error: err.message });
      emit({ type: "task-failed", id: task.id, error: err.message });
      return;
    }
  }

  emit({ type: "task-done", id: task.id });
}
