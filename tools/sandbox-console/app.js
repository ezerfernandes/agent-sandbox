import RFB from "./novnc/core/rfb.js";

const $ = (id) => document.getElementById(id);
const state = { rfb: null, running: false, lastMessageId: null, cancelStream: null };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const sessionId = () => $("sessionId").value.trim();
const template = () => $("template").value;

function setPill(text, cls = "") {
  const pill = $("vmPill");
  pill.textContent = text;
  pill.className = `pill ${cls}`;
}

function setLink(cls) {
  $("linkDot").className = `dot ${cls}`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * Read a server-sent-event stream, handing each parsed event to `onEvent`.
 *
 * Written by hand rather than with EventSource because EventSource cannot issue
 * a POST, and every stream here carries a request body.
 */
async function streamEvents(path, options, onEvent) {
  const res = await fetch(path, options);
  if (!res.body) throw new Error("no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const cancel = () => reader.cancel().catch(() => {});

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        /* a partial frame; the next read completes it */
      }
    }
  }
  return cancel;
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------
async function boot() {
  const id = sessionId();
  if (!id) return;
  $("btnBoot").disabled = true;
  setPill("booting…", "busy");
  setLink("busy");
  try {
    const r = await api(`/api/session/${encodeURIComponent(id)}/boot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: template() }),
    });
    setPill(`${template()} ready · ${r.ms}ms`, "live");
    setLink("on");
  } catch (err) {
    setPill(err.message.slice(0, 60), "err");
    setLink("err");
  } finally {
    $("btnBoot").disabled = false;
  }
}

async function destroy() {
  const id = sessionId();
  disconnect();
  setPill("destroying…", "busy");
  try {
    await api(`/api/session/${encodeURIComponent(id)}/destroy`, { method: "DELETE" });
    setPill("destroyed");
    setLink("");
  } catch (err) {
    setPill(err.message.slice(0, 60), "err");
  }
}

function connect() {
  const id = sessionId();
  if (!id || state.rfb) return;

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  // No credentials in this URL: the console process holds the API key and adds
  // the Authorization header when it dials the sandbox.
  const url = `${scheme}://${location.host}/websockify?session=${encodeURIComponent(id)}`;

  setPill("connecting…", "busy");
  setLink("busy");
  document.querySelector(".screen-pane").classList.remove("empty");

  const rfb = new RFB($("screen"), url, {});
  rfb.scaleViewport = $("scaleFit").checked;
  rfb.resizeSession = false;
  rfb.background = "#06080b";
  state.rfb = rfb;

  rfb.addEventListener("connect", () => {
    setPill("desktop live", "live");
    setLink("on");
    $("btnConnect").disabled = true;
    $("btnDisconnect").disabled = false;
    const { width, height } = rfb._fbWidth ? { width: rfb._fbWidth, height: rfb._fbHeight } : {};
    $("screenMeta").textContent = width ? `${width}×${height} · RFB` : "connected · RFB";
  });

  rfb.addEventListener("disconnect", (e) => {
    state.rfb = null;
    $("btnConnect").disabled = false;
    $("btnDisconnect").disabled = true;
    $("screenMeta").textContent = "not connected";
    document.querySelector(".screen-pane").classList.add("empty");
    if (e.detail.clean) {
      setPill("disconnected");
      setLink("");
    } else {
      setPill("connection lost — is this a desktop session?", "err");
      setLink("err");
    }
  });

  rfb.addEventListener("securityfailure", (e) => {
    setPill(`security failure: ${e.detail.reason}`, "err");
  });
}

function disconnect() {
  if (state.rfb) {
    state.rfb.disconnect();
    state.rfb = null;
  }
}

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------
function renderStep(event) {
  const step = el("div", "step running");
  step.dataset.index = String(event.index);
  const head = el("div", "step-head");
  head.append(el("span", "step-mark", "▸"), el("span", "step-title", event.title), el("span", "step-ms", "…"));
  step.append(head);
  if (event.detail) step.append(el("div", "step-detail", event.detail));
  return step;
}

async function runAgentTask(taskId, button) {
  if (state.running) return;
  const id = sessionId();
  if (!id) return;

  state.running = true;
  document.querySelectorAll(".task").forEach((b) => (b.disabled = true));
  button.classList.add("running");

  const log = $("agentLog");
  log.replaceChildren();

  let current = null;

  try {
    await streamEvents(
      `/api/session/${encodeURIComponent(id)}/agent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      },
      (event) => {
        if (event.type === "task-start") {
          log.append(el("div", "banner busy", `${event.label} — ${event.steps} steps`));
          setPill("agent running", "busy");
        }

        if (event.type === "step-start") {
          current = renderStep(event);
          log.append(current);
          current.scrollIntoView({ block: "nearest" });
        }

        if (event.type === "step-done" && current) {
          current.className = "step done";
          current.querySelector(".step-mark").textContent = "✓";
          current.querySelector(".step-ms").textContent = `${event.ms}ms`;
          if (event.output) current.append(el("pre", "step-out", event.output.trimEnd()));
          if (event.image) {
            const img = el("img", "step-shot");
            img.src = event.image;
            img.alt = "screenshot from the guest";
            img.loading = "lazy";
            current.append(img);
          }
          if (event.note) current.append(el("div", "step-note", event.note));
          current.scrollIntoView({ block: "nearest" });
        }

        if (event.type === "step-failed" && current) {
          current.className = "step failed";
          current.querySelector(".step-mark").textContent = "✗";
          current.querySelector(".step-ms").textContent = `${event.ms}ms`;
          current.append(el("pre", "step-out err", event.error));
        }

        if (event.type === "task-done") {
          log.append(el("div", "banner ok", "Task complete."));
          setPill("desktop live", state.rfb ? "live" : "");
        }

        if (event.type === "task-failed") {
          log.append(el("div", "banner err", `Task failed: ${event.error}`));
          setPill("agent failed", "err");
        }
      },
    );
  } catch (err) {
    log.append(el("div", "banner err", err.message));
  } finally {
    state.running = false;
    button.classList.remove("running");
    document.querySelectorAll(".task").forEach((b) => (b.disabled = false));
  }
}

async function loadTasks() {
  const list = $("taskList");
  try {
    const { tasks } = await api("/api/tasks");
    list.replaceChildren();
    for (const task of tasks) {
      const b = el("button", "task");
      b.type = "button";
      b.id = `task-${task.id}`;

      const top = el("div", "task-top");
      top.append(el("span", "task-label", task.label), el("span", `task-tpl ${task.template}`, task.template));
      b.append(top, el("div", "task-blurb", task.blurb));

      b.addEventListener("click", () => {
        // Point the session controls at whatever this task needs, so a desktop
        // task never silently runs against a headless session.
        $("template").value = task.template;
        runAgentTask(task.id, b);
      });
      list.append(b);
    }
  } catch (err) {
    list.append(el("div", "banner err", `Could not load tasks: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
const QUICK = [
  "uname -sr; cat /proc/1/comm",
  "free -m | head -2",
  "mount | grep -E ' / | /workspace '",
  "ps aux | head -12",
  "ip -br addr",
  "for i in 1 2 3 4 5; do echo tick $i; sleep 1; done",
];

function termWrite(text, cls) {
  const term = $("term");
  const node = cls ? el("span", cls, text) : document.createTextNode(text);
  term.append(node);
  term.scrollTop = term.scrollHeight;
}

async function runCommand(script) {
  if (state.running) return;
  const id = sessionId();
  if (!id || !script.trim()) return;

  state.running = true;
  $("btnRun").disabled = true;
  $("btnCancel").disabled = false;

  const messageId = `console-${Date.now()}`;
  state.lastMessageId = messageId;

  $("term").replaceChildren();
  termWrite(`$ ${script}\n`, "cmd");

  try {
    await streamEvents(
      `/api/session/${encodeURIComponent(id)}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "sh",
          args: ["-c", script],
          template: template(),
          messageId,
        }),
      },
      (event) => {
        if (event.type === "stream") termWrite(event.data, event.stream === "stderr" ? "err" : null);
        if (event.type === "result") {
          const signal = event.signal ? ` (signal ${event.signal})` : "";
          termWrite(`\n[exit ${event.exitCode}${signal} · ${event.duration}ms]\n`, "exit");
        }
        if (event.type === "error") termWrite(`\n${event.error}\n`, "err");
      },
    );
  } catch (err) {
    termWrite(`\n${err.message}\n`, "err");
  } finally {
    state.running = false;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
  }
}

async function cancelCommand() {
  if (!state.lastMessageId) return;
  try {
    await api(`/api/session/${encodeURIComponent(sessionId())}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: state.lastMessageId }),
    });
    termWrite("\n[cancel sent — SIGTERM to the process group]\n", "exit");
  } catch (err) {
    termWrite(`\ncancel failed: ${err.message}\n`, "err");
  }
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

async function listFiles(dir) {
  const list = $("fileList");
  const preview = $("filePreview");
  preview.replaceChildren();
  list.replaceChildren(el("p", "hint", "Listing…"));

  try {
    const data = await api(
      `/api/session/${encodeURIComponent(sessionId())}/files?path=${encodeURIComponent(dir)}`,
    );
    const entries = data.files ?? data.entries ?? [];
    list.replaceChildren();

    if (!entries.length) {
      list.append(el("p", "hint", `${dir} is empty.`));
      return;
    }

    for (const entry of entries) {
      const name = entry.name ?? entry.path ?? String(entry);
      const isDir = entry.type === "directory" || entry.isDirectory;
      const row = el("button", "file-row");
      row.type = "button";
      row.append(
        el("span", "fkind", isDir ? "▸" : "·"),
        el("span", "fname", name),
        el("span", "fsize", isDir ? "dir" : `${entry.size ?? 0} B`),
      );
      row.addEventListener("click", () => {
        const full = `${dir.replace(/\/$/, "")}/${name}`;
        if (isDir) {
          $("filePath").value = full;
          listFiles(full);
        } else {
          openFile(full);
        }
      });
      list.append(row);
    }
  } catch (err) {
    list.replaceChildren(el("div", "banner err", err.message));
  }
}

async function openFile(filePath) {
  const preview = $("filePreview");
  preview.replaceChildren(el("p", "hint", `Reading ${filePath}…`));
  const binary = IMAGE_RE.test(filePath);

  try {
    const data = await api(
      `/api/session/${encodeURIComponent(sessionId())}/read?path=${encodeURIComponent(filePath)}` +
        `&encoding=${binary ? "base64" : "utf8"}`,
    );
    preview.replaceChildren();

    if (binary) {
      const img = el("img");
      img.src = `data:image/png;base64,${data.content}`;
      img.alt = filePath;
      preview.append(img);
    } else {
      preview.append(el("pre", null, data.content));
    }
    preview.append(el("div", "step-note", `${filePath} · ${data.size} bytes`));
  } catch (err) {
    preview.replaceChildren(el("div", "banner err", err.message));
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
$("btnBoot").addEventListener("click", boot);
$("btnConnect").addEventListener("click", connect);
$("btnDisconnect").addEventListener("click", disconnect);
$("btnDestroy").addEventListener("click", destroy);
$("scaleFit").addEventListener("change", () => {
  if (state.rfb) state.rfb.scaleViewport = $("scaleFit").checked;
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

$("cmdForm").addEventListener("submit", (e) => {
  e.preventDefault();
  runCommand($("cmdInput").value);
});
$("btnCancel").addEventListener("click", cancelCommand);

$("fileForm").addEventListener("submit", (e) => {
  e.preventDefault();
  listFiles($("filePath").value.trim() || "/workspace");
});

for (const cmd of QUICK) {
  const chip = el("button", "chip", cmd.length > 34 ? `${cmd.slice(0, 32)}…` : cmd);
  chip.type = "button";
  chip.title = cmd;
  chip.addEventListener("click", () => {
    $("cmdInput").value = cmd;
    runCommand(cmd);
  });
  $("quickCmds").append(chip);
}

document.querySelector(".screen-pane").classList.add("empty");
loadTasks();

// Show which sandbox is behind this console, and whether it is answering.
fetch("/api/sessions")
  .then((r) => r.json())
  .then((d) => {
    const live = (d.sessions ?? []).map((s) => s.sessionId);
    $("sandboxUrl").textContent = live.length ? `${live.length} live session(s)` : "no live sessions";
    if (live.length) {
      $("sessionId").value = live[0];
      const first = (d.sessions ?? [])[0];
      if (first?.template) $("template").value = first.template;
      setPill(`${live[0]} · ${first?.state ?? "?"}`, "live");
      setLink("on");
    }
  })
  .catch(() => {
    $("sandboxUrl").textContent = "sandbox unreachable";
    setLink("err");
  });
