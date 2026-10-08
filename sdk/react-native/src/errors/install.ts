import type { DebugLogger } from "../logger";
import type { EventEmitter } from "../telemetry/events";
import { exceptionAttributes, serializeConsoleArgs } from "./classify";

/** React Native's global error hook (`global.ErrorUtils`). */
export interface ErrorUtilsLike {
  getGlobalHandler?(): GlobalErrorHandler | undefined;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}
export type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface RejectionTracker {
  enablePromiseRejectionTracker(options: {
    allRejections: boolean;
    onUnhandled: (id: number, error: unknown) => void;
    onHandled?: (id: number) => void;
  }): void;
  hasPromise?(): boolean;
}

export interface ErrorCaptureOptions {
  events: EventEmitter;
  logger: DebugLogger;
  /**
   * Runs for fatal errors before the previous handler: writes the crash marker and flushes.
   * Must resolve quickly (the caller bounds it with a timeout).
   */
  onFatal: (error: unknown) => Promise<void>;
  consoleErrors?: boolean;
}

/**
 * Installs the global error handler, unhandled promise rejection tracking and console.error
 * capture. The previous global handler (LogBox / native crash) still runs, after `onFatal`
 * for fatal errors, so the red box or the crash happens as before. Returns an uninstall function.
 */
export function installErrorCapture(opts: ErrorCaptureOptions): () => void {
  const { events, logger } = opts;
  const g = globalThis as {
    ErrorUtils?: ErrorUtilsLike;
    HermesInternal?: Partial<RejectionTracker>;
  };
  const restores: Array<() => void> = [];

  // ---- global handler ----
  // Errors already reported by one hook must not be reported again by another (Expo web has
  // both ErrorUtils and a window; a React Native error can reach ErrorUtils twice in dev).
  const seen = new WeakSet<object>();
  const firstSighting = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return true;
    if (seen.has(error)) return false;
    seen.add(error);
    return true;
  };
  const reportFatal = (error: unknown): void => {
    try {
      events.emit("exception", exceptionAttributes(error, "uncaught", true), "error");
    } catch (e) {
      logger.warn("exception capture failed", e);
    }
  };

  const errorUtils = g.ErrorUtils;
  const hasErrorUtils = !!errorUtils && typeof errorUtils.setGlobalHandler === "function";
  if (errorUtils && hasErrorUtils) {
    const previous = errorUtils.getGlobalHandler?.();
    let reentrant = false;
    const handler: GlobalErrorHandler = (error, isFatal) => {
      const fatal = isFatal === true;
      const callPrevious = (): void => {
        if (previous && previous !== handler) previous(error, isFatal);
      };
      if (reentrant || !firstSighting(error)) {
        callPrevious();
        return;
      }
      reentrant = true;
      try {
        events.emit("exception", exceptionAttributes(error, "uncaught", fatal), "error");
      } catch (e) {
        logger.warn("exception capture failed", e);
      } finally {
        reentrant = false;
      }
      if (!fatal) {
        callPrevious();
        return;
      }
      // Fatal: persist the crash marker and flush before the app dies / shows the red box.
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        callPrevious();
      };
      opts.onFatal(error).then(finish, finish);
    };
    errorUtils.setGlobalHandler(handler);
    restores.push(() => {
      if (previous) errorUtils.setGlobalHandler(previous);
    });
    logger.log("global error handler installed");
  }
  // react-native-web / Expo web: browser timers and event handlers never reach ErrorUtils
  // (which Expo still bundles for web), so the window `error` event is needed as well. An
  // uncaught error counts as fatal, like the browser SDK (ADR-0004), so the web build of the
  // app can still demonstrate a crash.
  const hasWindowEvents = typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function";
  if (hasWindowEvents) {
    const target = globalThis as unknown as EventTarget;
    const onError = (event: Event): void => {
      const ev = event as { error?: unknown; message?: string };
      const error = ev.error ?? ev.message ?? "Unknown error";
      if (!firstSighting(error)) return;
      reportFatal(error);
      void opts.onFatal(error);
    };
    target.addEventListener("error", onError);
    restores.push(() => target.removeEventListener("error", onError));
    logger.log(hasErrorUtils ? "window error listener installed alongside ErrorUtils" : "global error handler installed (window error event)");
  }
  if (!hasErrorUtils && !hasWindowEvents) {
    logger.warn("ErrorUtils not available: fatal errors are not captured");
  }

  // ---- unhandled promise rejections ----
  const onUnhandled = (_id: number, error: unknown): void => {
    try {
      events.emit("exception", exceptionAttributes(error ?? "Unhandled rejection", "unhandledrejection", false), "error");
    } catch (e) {
      logger.warn("rejection capture failed", e);
    }
    // React Native's own tracker printed a warning; keep that behaviour visible when debugging.
    logger.warn("Possible unhandled promise rejection", error);
  };
  const hermes = g.HermesInternal;
  if (hermes && typeof hermes.enablePromiseRejectionTracker === "function" && (hermes.hasPromise?.() ?? true)) {
    hermes.enablePromiseRejectionTracker({ allRejections: true, onUnhandled });
    logger.log("promise rejection tracking: HermesInternal");
  } else if (hasWindowEvents) {
    const target = globalThis as unknown as EventTarget;
    const onRejection = (event: Event): void => onUnhandled(0, (event as { reason?: unknown }).reason ?? "Unhandled rejection");
    target.addEventListener("unhandledrejection", onRejection);
    restores.push(() => target.removeEventListener("unhandledrejection", onRejection));
    logger.log("promise rejection tracking: window unhandledrejection event");
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracking = require("promise/setimmediate/rejection-tracking") as { enable(o: { allRejections: boolean; onUnhandled: (id: number, e: unknown) => void }): void };
      tracking.enable({ allRejections: true, onUnhandled });
      logger.log("promise rejection tracking: promise/setimmediate/rejection-tracking");
    } catch {
      logger.warn("no promise rejection tracker available");
    }
  }

  // ---- console.error ----
  if (opts.consoleErrors !== false && typeof console !== "undefined") {
    const original = console.error;
    let reentrant = false;
    console.error = function ouoConsoleError(this: unknown, ...args: unknown[]): void {
      original.apply(this === undefined ? console : this, args);
      if (reentrant) return;
      reentrant = true;
      try {
        const { error } = serializeConsoleArgs(args);
        events.emit("exception", exceptionAttributes(error, "console", false), "error");
      } catch (e) {
        logger.warn("console.error capture failed", e);
      } finally {
        reentrant = false;
      }
    };
    restores.push(() => {
      console.error = original;
    });
  }

  return () => {
    for (const r of restores.splice(0)) r();
  };
}
