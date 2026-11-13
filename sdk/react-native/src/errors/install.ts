import { guard } from "../guard";
import type { DebugLogger } from "../logger";
import type { EventEmitter } from "../telemetry/events";
import type { Attrs } from "../types";
import { exceptionAttributes, serializeConsoleArgs } from "./classify";
import { ReportedErrors } from "./dedupe";
import { forwardRejectionToSentry } from "./sentry";

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
  /**
   * Also hands every unhandled promise rejection to this function (see ErrorOptions). Without
   * it, a rejection is handed to the Sentry SDK when one is initialised (spec ERR-3).
   */
  onUnhandledRejection?: (error: unknown) => void;
  /** Errors already reported, shared with the Sentry forwarder. */
  reported?: ReportedErrors;
  /** Emits one `exception` record; defaults to `events.emit`. `initRUM` adds the error's trace context. */
  emitException?: (error: unknown, attrs: Attrs) => void;
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
  // False once uninstalled: a patch that could not be removed (another SDK patched after ouo,
  // the Hermes rejection tracker) then only passes through.
  let active = true;
  const reported = opts.reported ?? new ReportedErrors();
  const emitException = opts.emitException ?? ((_error: unknown, attrs: Attrs) => events.emit("exception", attrs, "error"));

  // ---- global handler ----
  // Errors already reported by one hook must not be reported again by another (Expo web has
  // both ErrorUtils and a window; a React Native error can reach ErrorUtils twice in dev; a
  // fatal's echoes, checklist Q1, src/errors/dedupe.ts).
  const firstSighting = (error: unknown): boolean => reported.add(error) && !reported.isFatalRepeat(error);
  // An error already reported as non-fatal (it escaped `withSpan`, the app logged it) that now
  // arrives as fatal is reported again: the crash must not be lost to de-duplication.
  const reportable = (error: unknown, fatal: boolean): boolean => firstSighting(error) || (fatal && !reported.isFatalRepeat(error));
  const reportFatal = (error: unknown): void => {
    emitException(error, exceptionAttributes(error, "uncaught", true));
    reported.markFatal(error);
  };

  const errorUtils = g.ErrorUtils;
  const hasErrorUtils = !!errorUtils && typeof errorUtils.setGlobalHandler === "function";
  if (errorUtils && hasErrorUtils) {
    const previous = errorUtils.getGlobalHandler?.();
    let reentrant = false;
    // ERR-3: the previous handler (LogBox, the native crash, another SDK) always runs, exactly
    // once, whatever the SDK's own part does: that part runs inside the guard.
    const handler: GlobalErrorHandler = (error, isFatal) => {
      let called = false;
      const callPrevious = (): void => {
        if (called) return;
        called = true;
        if (previous && previous !== handler) previous(error, isFatal);
      };
      const wait = !active ? undefined : guard.run("errors.global", () => {
        const fatal = isFatal === true;
        if (reentrant || !reportable(error, fatal)) return undefined;
        reentrant = true;
        try {
          emitException(error, exceptionAttributes(error, "uncaught", fatal));
          if (fatal) reported.markFatal(error);
        } finally {
          reentrant = false;
        }
        // Fatal: persist the crash marker and flush before the app dies / shows the red box.
        return fatal ? opts.onFatal(error) : undefined;
      });
      if (wait && typeof wait.then === "function") wait.then(callPrevious, callPrevious);
      else callPrevious();
    };
    errorUtils.setGlobalHandler(handler);
    restores.push(() => {
      // Only when ouo's handler is still the current one: a handler installed after it (Sentry
      // initialised later) chains to ouo's and must not be removed.
      const current = errorUtils.getGlobalHandler?.();
      if (previous && (current === undefined || current === handler)) errorUtils.setGlobalHandler(previous);
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
    const onError = guard.wrap("errors.window", (event: Event): void => {
      const ev = event as { error?: unknown; message?: string };
      const error = ev.error ?? ev.message ?? "Unknown error";
      if (!firstSighting(error)) return;
      reportFatal(error);
      void opts.onFatal(error);
    });
    target.addEventListener("error", onError);
    restores.push(() => target.removeEventListener("error", onError));
    logger.log(hasErrorUtils ? "window error listener installed alongside ErrorUtils" : "global error handler installed (window error event)");
  }
  if (!hasErrorUtils && !hasWindowEvents) {
    logger.warn("ErrorUtils not available: fatal errors are not captured");
  }

  // ---- unhandled promise rejections ----
  const onUnhandled = (_id: number, error: unknown): void => {
    if (active) guard.run("errors.rejection", () => {
      if (reported.add(error)) emitException(error, exceptionAttributes(error ?? "Unhandled rejection", "unhandledrejection", false));
    });
    // ERR-3: the rejection goes on. Hermes keeps one tracker and gives no way to read the one
    // that was there (see below), so it goes to the app's function, else to Sentry when present.
    const forward = opts.onUnhandledRejection;
    if (forward) guard.host("errors.onUnhandledRejection", () => forward(error));
    else guard.host("errors.rejection.sentry", () => forwardRejectionToSentry(error));
    // React Native's own tracker printed a warning; keep that behaviour visible when debugging.
    logger.warn("Possible unhandled promise rejection", error);
  };
  const hermes = g.HermesInternal;
  if (hermes && typeof hermes.enablePromiseRejectionTracker === "function" && (hermes.hasPromise?.() ?? true)) {
    // Hermes keeps ONE tracker, has no getter for it, and HermesInternal is frozen, so the tracker
    // registered before (Sentry's) can be neither read nor wrapped: this call replaces it.
    // `onUnhandled` above hands every rejection to Sentry itself instead (or to the app's
    // errors.onUnhandledRejection), which is what Sentry's own tracker did with it.
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
    const patched = function ouoConsoleError(this: unknown, ...args: unknown[]): void {
      // The app's call first, untouched; the SDK's part after it, inside the guard.
      original.apply(this === undefined ? console : this, args);
      if (reentrant || !active) return;
      reentrant = true;
      guard.run("errors.console", () => {
        // React logs the error it caught (an error boundary, a render error) with the Error
        // object itself: already reported when the global handler or Sentry saw it.
        const errorArg = args.find((a) => a instanceof Error);
        const { error, message } = serializeConsoleArgs(args);
        if ((errorArg === undefined || reported.add(errorArg)) && !reported.isFatalEcho(message)) {
          emitException(errorArg ?? error, exceptionAttributes(error, "console", false));
        }
      });
      reentrant = false;
    };
    console.error = patched;
    restores.push(() => {
      // Only when it is still ours: a patch installed after it calls ours and must stay.
      if (console.error === patched) console.error = original;
    });
  }

  return () => {
    active = false;
    for (const r of restores.splice(0)) guard.host("errors.uninstall", r);
  };
}
