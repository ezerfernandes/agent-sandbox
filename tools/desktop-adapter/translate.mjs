/**
 * Translation from desktop-control requests to guest commands.
 *
 * Pure: every function here takes a parsed request body and returns either a
 * command to run or a validation error. No I/O, so the whole mapping is
 * testable without a microVM.
 *
 * Everything is emitted as argv — `{ command, args }` — and never as a shell
 * line. The sandbox's /execute spawns argv directly, so text arriving from a
 * caller cannot be interpreted: typing `; rm -rf /` types those characters.
 * A single `sh -c` here would undo that for every route at once.
 */

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const MAX_TEXT_LENGTH = 4096;
const MAX_HOLD_MS = 60_000;
const MAX_WAIT_MS = 30_000;
const MAX_SCROLL_NOTCHES = 100;

/** Wheel buttons. X11 has no pixel-precise scroll; it has notches. */
const WHEEL = { up: "4", down: "5", left: "6", right: "7" };
const BUTTONS = { left: "1", middle: "2", right: "3" };
const MODIFIERS = new Set(["ctrl", "alt", "shift", "meta"]);

/**
 * X keysym names: letters, digits, and the underscore forms like `Page_Down`.
 * Validated even though argv makes shell injection impossible, because xdotool
 * itself parses this string and `a+b+c` means something to it.
 */
const KEY_NAME = /^[A-Za-z0-9_]{1,32}$/;

function int(value, name, { min, max }) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BadRequest(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) throw new BadRequest(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new BadRequest(`${name} must be <= ${max}`);
  return value;
}

/**
 * Coordinates are bounded by the session's real display, queried at runtime,
 * rather than by the 1279x799 the schema hardcodes: DESKTOP_GEOMETRY is a
 * per-template setting, and a caller on a differently-sized guest deserves a
 * clear 400 rather than a click silently landing off-screen.
 */
function point(body, geometry) {
  const x = int(body?.x, "x", { min: 0, max: geometry.width - 1 });
  const y = int(body?.y, "y", { min: 0, max: geometry.height - 1 });
  return { x, y };
}

export function mouseMove(body, geometry) {
  const { x, y } = point(body, geometry);
  return { command: "xdotool", args: ["mousemove", String(x), String(y)] };
}

export function mouseClick(body, geometry) {
  const { x, y } = point(body, geometry);

  const name = body.button ?? "left";
  if (!Object.hasOwn(BUTTONS, name)) {
    throw new BadRequest(`button must be one of: ${Object.keys(BUTTONS).join(", ")}`);
  }
  const button = BUTTONS[name];

  const hold = body.holdDurationMs === undefined
    ? 0
    : int(body.holdDurationMs, "holdDurationMs", { min: 0, max: MAX_HOLD_MS });

  // xdotool chains commands in one invocation, so a press-and-hold stays a
  // single round trip to the guest instead of three that race each other.
  const args = hold > 0
    ? ["mousemove", String(x), String(y), "mousedown", button, "sleep", (hold / 1000).toFixed(3), "mouseup", button]
    : ["mousemove", String(x), String(y), "click", button];

  return { command: "xdotool", args };
}

/**
 * X11 scrolling is discrete button presses, but the schema speaks pixels, so
 * this divides by a notch size and rounds. The conversion is lossy by nature:
 * any nonzero delta becomes at least one notch, and fractional notches are not
 * representable. `pixelsPerNotch` is configurable because toolkits disagree.
 */
export function mouseScroll(body, geometry, pixelsPerNotch = 100) {
  const { x, y } = point(body, geometry);

  const deltaY = body.deltaY === undefined ? 0 : int(body.deltaY, "deltaY", {});
  const deltaX = body.deltaX === undefined ? 0 : int(body.deltaX, "deltaX", {});
  if (deltaY === 0 && deltaX === 0) throw new BadRequest("deltaY or deltaX must be nonzero");

  const notches = (delta) => Math.min(MAX_SCROLL_NOTCHES, Math.max(1, Math.round(Math.abs(delta) / pixelsPerNotch)));

  const args = ["mousemove", String(x), String(y)];
  if (deltaY !== 0) args.push("click", "--repeat", String(notches(deltaY)), deltaY > 0 ? WHEEL.down : WHEEL.up);
  if (deltaX !== 0) args.push("click", "--repeat", String(notches(deltaX)), deltaX > 0 ? WHEEL.right : WHEEL.left);

  return {
    command: "xdotool",
    args,
    note: `${deltaY}px vertical -> ${deltaY ? notches(deltaY) : 0} notch(es) at ${pixelsPerNotch}px each`,
  };
}

export function keyboardType(body, _geometry, typeDelayMs = 12) {
  const { text } = body ?? {};
  if (typeof text !== "string") throw new BadRequest("text must be a string");
  if (!text.length) throw new BadRequest("text must not be empty");
  if (text.length > MAX_TEXT_LENGTH) throw new BadRequest(`text must be <= ${MAX_TEXT_LENGTH} characters`);

  // `--` stops xdotool reading a leading-dash payload as its own options, and
  // the text is a single argv element, so no character in it is special.
  return { command: "xdotool", args: ["type", "--delay", String(typeDelayMs), "--", text] };
}

export function keyboardKey(body) {
  const { key, modifiers } = body ?? {};
  if (typeof key !== "string" || !KEY_NAME.test(key)) {
    throw new BadRequest("key must be an X keysym name, e.g. Enter, Escape, Tab, Page_Down");
  }

  let chord = key;
  if (modifiers !== undefined) {
    if (!Array.isArray(modifiers)) throw new BadRequest("modifiers must be an array");
    for (const m of modifiers) {
      if (!MODIFIERS.has(m)) throw new BadRequest(`modifier must be one of: ${[...MODIFIERS].join(", ")}`);
    }
    // xdotool spells the super key `super`, and orders modifiers before the key.
    const spelled = modifiers.map((m) => (m === "meta" ? "super" : m));
    chord = [...spelled, key].join("+");
  }

  return { command: "xdotool", args: ["key", chord] };
}

export function waitMs(body) {
  const ms = body?.ms === undefined ? 0 : int(body.ms, "ms", { min: 0, max: MAX_WAIT_MS });
  return { ms };
}

/**
 * Where a screenshot is staged inside the guest before being read back.
 *
 * Under /workspace, not /tmp: the guest runtime resolves every file path
 * against /workspace and answers "Path traversal detected" for anything
 * outside it, so a /tmp staging path fails the read even though scrot wrote it
 * quite happily. Dot-prefixed to stay out of a caller's file listing.
 */
export const SHOT_PNG = "/workspace/.adapter-shot.png";
export const SHOT_WEBP = "/workspace/.adapter-shot.webp";

export function screenshotCommand({ webp, quality = 82 }) {
  // scrot writes PNG; cwebp re-encodes when the guest has libwebp-tools. Both
  // in one chain so a capture is one round trip either way.
  const script = webp
    ? `scrot -o ${SHOT_PNG} && cwebp -quiet -q ${quality} ${SHOT_PNG} -o ${SHOT_WEBP}`
    : `scrot -o ${SHOT_PNG}`;
  return { command: "sh", args: ["-c", script] };
}

export const LIMITS = { MAX_TEXT_LENGTH, MAX_HOLD_MS, MAX_WAIT_MS, MAX_SCROLL_NOTCHES };
