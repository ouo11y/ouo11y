import type { Attrs } from "../types";

export type ExceptionKind = "uncaught" | "unhandledrejection" | "console" | "captured" | "resource";

export interface SerializedError {
  type: string;
  message: string;
  stacktrace: string;
}

/** Turns any thrown value into `exception.*` fields. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      message: err.message,
      stacktrace: typeof err.stack === "string" ? err.stack : "",
    };
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o["message"] === "string") {
      return {
        type: typeof o["name"] === "string" ? o["name"] : "Error",
        message: o["message"],
        stacktrace: typeof o["stack"] === "string" ? o["stack"] : "",
      };
    }
    return { type: "Object", message: safeStringify(err), stacktrace: "" };
  }
  return { type: typeof err === "string" ? "Error" : capitalize(typeof err), message: String(err), stacktrace: "" };
}

/** Pure classification of an exception event: who reported it decides fatal/handled (ADR-0004). */
export function exceptionAttributes(err: unknown, kind: ExceptionKind, extra: Attrs = {}): Attrs {
  const s = serializeError(err);
  const fatal = kind === "uncaught" || kind === "unhandledrejection";
  return {
    "exception.type": s.type,
    "exception.message": s.message,
    "exception.stacktrace": s.stacktrace,
    "ouo.exception.fatal": fatal,
    "ouo.exception.handled": !fatal,
    "ouo.exception.kind": kind,
    ...debugIdAttribute(s.stacktrace),
    ...extra,
  };
}

/** Registry the `ouo-sourcemaps inject` snippet fills: `new Error().stack` of the bundle -> its debug id (ADR-0011). */
type DebugIdRegistry = Record<string, string>;

const frameUrl = /(?:https?|file|blob|webpack|app):\/\/[^\s()'"]+?(?=:\d+:\d+|:\d+\)|\)|\s|$)/g;

let parsedFrom = -1;
let urlToDebugId = new Map<string, string>();

/** Script URL -> debug id for every bundle that registered one; re-parsed only when the registry grows. */
function debugIdsByUrl(): Map<string, string> {
  const reg = (globalThis as { __ouoDebugIds?: DebugIdRegistry }).__ouoDebugIds;
  if (!reg || typeof reg !== "object") return urlToDebugId;
  const keys = Object.keys(reg);
  if (keys.length === parsedFrom) return urlToDebugId;
  const next = new Map<string, string>();
  for (const stack of keys) {
    const id = reg[stack];
    // The snippet's own frame is the first URL in its stack (Firefox and Safari have no "Error" line).
    const url = stack.match(frameUrl)?.[0];
    if (url && typeof id === "string") next.set(url, id);
  }
  parsedFrom = keys.length;
  urlToDebugId = next;
  return next;
}

/** `ouo.exception.debug_ids`: JSON `{ script url: debug id }` for the scripts the stack names. */
export function debugIdAttribute(stack: string): Attrs {
  if (!stack) return {};
  try {
    const known = debugIdsByUrl();
    if (known.size === 0) return {};
    const out: Record<string, string> = {};
    let n = 0;
    for (const url of stack.match(frameUrl) ?? []) {
      const id = known.get(url);
      if (id && !(url in out)) {
        out[url] = id;
        n++;
      }
    }
    return n > 0 ? { "ouo.exception.debug_ids": JSON.stringify(out) } : {};
  } catch {
    return {};
  }
}

/** `console.error(a, b, c)` -> one message string; Errors keep their stack. */
export function serializeConsoleArgs(args: unknown[]): { error: unknown; message: string } {
  const firstError = args.find((a) => a instanceof Error);
  const message = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  if (firstError instanceof Error) {
    const clone = new Error(message);
    clone.name = firstError.name;
    clone.stack = firstError.stack ?? "";
    return { error: clone, message };
  }
  return { error: { name: "ConsoleError", message, stack: "" }, message };
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 2000 ? `${s.slice(0, 2000)}...` : s;
  } catch {
    return String(v);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
