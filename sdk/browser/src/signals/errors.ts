/**
 * Errors (SIG-08): window `error` and `unhandledrejection` become `exception` events at ERROR
 * with `ouo.exception.handled=false`, which puts them in the bypass set (SMP-5). Listeners only,
 * never `window.onerror`, and no `preventDefault`: the page's own handlers, the console output
 * and the browser's default behaviour are exactly what they are without the SDK (ERR-3).
 * `console.error` and failed resource loads are not errors here.
 */
import type { Attrs } from "../core/limits";
import { listen } from "../guard";

export type ExceptionSource = "error" | "unhandledrejection" | "manual";

export interface SerializedError {
  type: string;
  message: string;
  stacktrace: string;
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return Object.prototype.toString.call(v);
  }
}

/** Turns any thrown value into `exception.*` fields. Never throws, whatever the value. */
export function serializeError(err: unknown): SerializedError {
  try {
    if (err instanceof Error) return { type: String(err.name || "Error"), message: String(err.message), stacktrace: typeof err.stack === "string" ? err.stack : "" };
    if (err && typeof err === "object") {
      const o = err as Record<string, unknown>;
      if (typeof o["message"] === "string") {
        return { type: typeof o["name"] === "string" ? o["name"] : "Error", message: o["message"], stacktrace: typeof o["stack"] === "string" ? o["stack"] : "" };
      }
      return { type: "Object", message: safeStringify(err), stacktrace: "" };
    }
    return { type: typeof err === "string" ? "Error" : typeof err, message: String(err), stacktrace: "" };
  } catch {
    return { type: "Error", message: "unserializable error", stacktrace: "" };
  }
}

/**
 * `ouo.exception.debug_ids`: JSON `{ script url: debug id }` for the scripts the stack names.
 * `ouo-sourcemaps inject` makes every bundle register its URL in `globalThis.__ouoDebugIds`.
 */
function debugIds(stack: string, sanitize: (url: string) => string): string | undefined {
  try {
    const reg = (globalThis as { __ouoDebugIds?: Record<string, string> }).__ouoDebugIds;
    if (!reg) return undefined;
    const out: Record<string, string> = {};
    let any = false;
    for (const url in reg) {
      if (stack.includes(url + ":")) {
        out[sanitize(url)] = String(reg[url]);
        any = true;
      }
    }
    return any ? JSON.stringify(out) : undefined;
  } catch {
    return undefined;
  }
}

export interface ExceptionOptions {
  source: ExceptionSource;
  handled: boolean;
  sanitize(url: string): string;
  sanitizeStack(stack: string): string;
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
}

/** The attributes of one `exception` event. The SDK never computes a fingerprint (SIG-34). */
export function exceptionAttributes(err: unknown, o: ExceptionOptions): Attrs {
  const s = serializeError(err);
  const attrs: Attrs = {
    "exception.type": s.type,
    "exception.message": s.message,
    "ouo.exception.source": o.source,
    "ouo.exception.handled": o.handled,
  };
  if (s.stacktrace) {
    attrs["exception.stacktrace"] = o.sanitizeStack(s.stacktrace);
    const ids = debugIds(s.stacktrace, o.sanitize);
    if (ids) attrs["ouo.exception.debug_ids"] = ids;
  }
  if (o.file) attrs["code.file.path"] = o.sanitize(o.file);
  if (typeof o.line === "number" && o.line > 0) attrs["code.line.number"] = o.line;
  if (typeof o.column === "number" && o.column > 0) attrs["code.column.number"] = o.column;
  return attrs;
}

/** Errors already reported through `recordException`: the window handler skips them. */
const reported = new WeakSet<object>();

export function markReported(err: unknown): void {
  if (err && typeof err === "object") reported.add(err);
}

export interface ErrorCaptureDeps {
  emit(attrs: Attrs): void;
  sanitize(url: string): string;
  sanitizeStack(stack: string): string;
}

export function installErrorCapture(d: ErrorCaptureDeps): () => void {
  const win = globalThis as unknown as Window;
  const offError = listen(win, "error", (event) => {
    const ev = event as ErrorEvent;
    // Resource load failures arrive here in the capture phase with an element as target.
    if (ev.target && typeof (ev.target as Element).tagName === "string") return;
    const err = ev.error ?? ev.message ?? "Unknown error";
    if (err && typeof err === "object" && reported.has(err)) return;
    d.emit(exceptionAttributes(err, { source: "error", handled: false, sanitize: d.sanitize, sanitizeStack: d.sanitizeStack, file: ev.filename, line: ev.lineno, column: ev.colno }));
  }, true);
  const offRejection = listen(win, "unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason ?? "Unhandled rejection";
    if (reason && typeof reason === "object" && reported.has(reason)) return;
    d.emit(exceptionAttributes(reason, { source: "unhandledrejection", handled: false, sanitize: d.sanitize, sanitizeStack: d.sanitizeStack }));
  });
  return () => {
    offError();
    offRejection();
  };
}
