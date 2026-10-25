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

/**
 * `ouo.exception.debug_ids` (ADR-0011): JSON `{ script url: debug id }` for the scripts the stack
 * names. `ouo-sourcemaps inject` makes every bundle register its own URL -> debug id in
 * `globalThis.__ouoDebugIds`, so this only checks which registered URLs the stack mentions (followed
 * by ":<line>"). Kept this small on purpose: it counts against the core bundle budget.
 */
export function debugIdAttribute(stack: string): Attrs {
  try {
    const reg = (globalThis as { __ouoDebugIds?: Record<string, string> }).__ouoDebugIds;
    const out: Record<string, string> = {};
    for (const url in reg) if (stack.includes(url + ":")) out[url] = reg[url]!;
    const json = JSON.stringify(out);
    return json != "{}" ? { "ouo.exception.debug_ids": json } : {};
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
