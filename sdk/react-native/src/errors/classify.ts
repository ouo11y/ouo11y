import type { Attrs } from "../types";
import { debugIdAttribute } from "./debugids";
import { normalizeStack } from "./stack";

export type ExceptionKind = "uncaught" | "unhandledrejection" | "console" | "captured" | "sentry";

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

/**
 * Pure classification of an exception event (ADR-0004, mobile): only an error that reaches
 * the global handler with `isFatal` is fatal. Unhandled rejections are unhandled but not fatal.
 * The stack is normalised (`app:///` paths, `[in app]` frames, `src/errors/stack.ts`).
 */
export function exceptionAttributes(err: unknown, kind: ExceptionKind, fatal: boolean, extra: Attrs = {}, handledOverride?: boolean): Attrs {
  const s = serializeError(err);
  const handled = handledOverride ?? (kind === "console" || kind === "captured" || kind === "sentry");
  const stacktrace = normalizeStack(s.stacktrace).stacktrace;
  return {
    "exception.type": s.type,
    "exception.message": s.message,
    "exception.stacktrace": stacktrace,
    "ouo.exception.fatal": fatal,
    "ouo.exception.handled": handled,
    "ouo.exception.kind": kind,
    // Read when the error is captured, so a record sent later (persisted, retried after a
    // restart that applied an OTA update) still names the bundle that threw.
    ...debugIdAttribute(stacktrace),
    ...extra,
  };
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
