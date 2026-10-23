/**
 * Stack normalisation (checklist G5). Hermes and JSC print absolute bundle paths that hold
 * per-install container UUIDs (`/private/var/containers/Bundle/Application/<uuid>/App.app/main.jsbundle`,
 * the simulator's `.../CoreSimulator/Devices/<uuid>/...`) or the Metro URL with its query. The
 * same error then reads differently on every device and never groups. Frames are rewritten to
 * `app:///<bundle>` like Sentry's RewriteFrames, one frame per line in the form the Sentry bridge
 * writes (`  at {function} ({file}:{line}:{column})`, spec section 6), with `[in app]` on frames
 * of the app's own code.
 */

export interface StackFrame {
  function: string;
  /** Normalised location (`app:///main.jsbundle:1:2345`, `native`), empty when unknown. */
  location: string;
  inApp: boolean;
}

export interface NormalizedStack {
  stacktrace: string;
  frames: StackFrame[];
}

const BUNDLE_FILE = /([^/\\?#]+\.(?:jsbundle|bundle|hbc))(?=[/?#:&]|$)/;
// iOS device and simulator containers, Android app data: everything up to the app's own folder.
const CONTAINER_PREFIX = [
  /^.*?\/[^/]+\.app\//,
  /^.*?\/(?:Containers\/(?:Data|Bundle)\/Application|CoreSimulator\/Devices)\/[0-9A-Fa-f-]{36}\/(?:data\/Containers\/(?:Data|Bundle)\/Application\/[0-9A-Fa-f-]{36}\/)?/,
  /^\/data\/(?:user\/\d+|data|app\/[^/]+)\/[^/]+\//,
];
const POSITION = /(:\d+(?::\d+)?)$/;

/** `address at /…/App.app/main.jsbundle:1:2345` -> `app:///main.jsbundle:1:2345`. */
export function normalizeLocation(raw: string): string {
  let loc = raw.trim().replace(/^address at\s+/, "");
  if (loc === "" || loc === "native" || loc === "[native code]") return loc;
  const pos = POSITION.exec(loc)?.[1] ?? "";
  let file = pos ? loc.slice(0, -pos.length) : loc;
  const bundle = BUNDLE_FILE.exec(file);
  if (bundle) return `app:///${bundle[1]}${pos}`;
  if (/^https?:\/\//.test(file)) {
    // Metro serves modules by path in dev: keep the path, drop host and query.
    const path = file.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
    return `app://${path.startsWith("/") ? "" : "/"}${path}${pos}`;
  }
  for (const prefix of CONTAINER_PREFIX) {
    if (prefix.test(file)) {
      file = file.replace(prefix, "");
      return `app:///${file}${pos}`;
    }
  }
  loc = `${file}${pos}`;
  return loc;
}

/** Frames of the app's code: not native, not the engine's own bytecode, not a dependency. */
export function isInApp(location: string): boolean {
  if (!location || location === "native" || location === "[native code]") return false;
  if (/InternalBytecode|\/node_modules\/|^node:|\[native code\]/.test(location)) return false;
  return true;
}

const V8_FRAME = /^\s*at (?:(.+?) \((.*)\)|(.+))$/;
const JSC_FRAME = /^\s*(?:(.*?)@)?(\S+:\d+(?::\d+)?|\[native code\])\s*$/;

function parseFrame(line: string): { fn: string; loc: string } | undefined {
  const v8 = V8_FRAME.exec(line);
  if (v8) {
    if (v8[3] !== undefined) {
      // `at file:1:2` (anonymous) or `at fn` without a location
      return /:\d+/.test(v8[3]) || v8[3].startsWith("address at") ? { fn: "?", loc: v8[3] } : { fn: v8[3], loc: "" };
    }
    return { fn: v8[1] ?? "?", loc: v8[2] ?? "" };
  }
  const jsc = JSC_FRAME.exec(line);
  if (jsc && line.trim() !== "") return { fn: jsc[1] || "?", loc: jsc[2] ?? "" };
  return undefined;
}

/** Rewrites every frame line; other lines (the `Type: message` header) are kept as they are. */
export function normalizeStack(stack: string): NormalizedStack {
  if (!stack) return { stacktrace: "", frames: [] };
  const frames: StackFrame[] = [];
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    const parsed = parseFrame(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    const location = normalizeLocation(parsed.loc);
    const frame: StackFrame = { function: parsed.fn, location, inApp: isInApp(location) };
    frames.push(frame);
    out.push(`  at ${frame.function}${location ? ` (${location})` : ""}${frame.inApp ? " [in app]" : ""}`);
  }
  return { stacktrace: out.join("\n"), frames };
}
