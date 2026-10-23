import type { EventEmitter } from "../telemetry/events";
import type { DebugLogger } from "../logger";
import { exceptionAttributes, serializeConsoleArgs } from "./classify";

/** Error objects reported through `captureError`; a `console.error` of the same object is not reported again. */
const claimed = new WeakSet<object>();

/** Marks an error as reported (by `captureError`), so the console capture skips it. */
export function claimError(err: unknown): void {
  if (err && typeof err === "object") claimed.add(err);
}

export interface ErrorCaptureOptions {
  events: EventEmitter;
  logger: DebugLogger;
  /** Also instrument `console.error`. Default true. */
  consoleErrors?: boolean;
}

/** Installs window error, unhandledrejection, resource error and console.error capture. Returns an uninstall function. */
export function installErrorCapture(opts: ErrorCaptureOptions): () => void {
  const { events, logger } = opts;
  const win = globalThis as unknown as Window;

  const onError = (event: Event): void => {
    const target = event.target;
    // Resource load failures bubble as plain `error` events on the element (capture phase only).
    if (target && target !== win && target !== (globalThis as unknown as { document?: unknown }).document && isElement(target)) {
      const el = target as HTMLElement & { src?: string; href?: string };
      const url = el.src || el.href || "";
      events.emit(
        "exception",
        exceptionAttributes({ name: "ResourceError", message: `Failed to load ${el.tagName.toLowerCase()} ${url}` }, "resource", {
          "url.full": url,
        }),
        "warn",
      );
      return;
    }
    const ev = event as ErrorEvent;
    const err = ev.error ?? ev.message ?? "Unknown error";
    events.emit(
      "exception",
      exceptionAttributes(err, "uncaught", {
        ...(ev.filename ? { "code.filepath": ev.filename } : {}),
        ...(typeof ev.lineno === "number" && ev.lineno > 0 ? { "code.lineno": ev.lineno } : {}),
      }),
      "error",
    );
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    events.emit("exception", exceptionAttributes(event.reason ?? "Unhandled rejection", "unhandledrejection"), "error");
  };

  win.addEventListener("error", onError, true);
  win.addEventListener("unhandledrejection", onRejection);

  let restoreConsole: (() => void) | undefined;
  if (opts.consoleErrors !== false && typeof console !== "undefined") {
    const original = console.error;
    let reentrant = false;
    console.error = function ouoConsoleError(this: unknown, ...args: unknown[]): void {
      original.apply(this === undefined ? console : this, args);
      if (reentrant) return;
      reentrant = true;
      try {
        const { error } = serializeConsoleArgs(args);
        // One microtask later: React logs an error its boundary caught with console.error right
        // before componentDidCatch, where OuoErrorBoundary reports the same object with
        // captureError; that one report wins.
        queueMicrotask(() => {
          if (args.some((a) => a !== null && typeof a === "object" && claimed.has(a))) return;
          events.emit("exception", exceptionAttributes(error, "console"), "error");
        });
      } catch (e) {
        logger.warn("console.error capture failed", e);
      } finally {
        reentrant = false;
      }
    };
    restoreConsole = () => {
      console.error = original;
    };
  }

  return () => {
    win.removeEventListener("error", onError, true);
    win.removeEventListener("unhandledrejection", onRejection);
    restoreConsole?.();
  };
}

function isElement(t: EventTarget): boolean {
  return typeof (t as { tagName?: unknown }).tagName === "string";
}
