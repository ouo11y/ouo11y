import type { DebugLogger } from "./logger";

/**
 * Failure isolation (spec ERR-1, ERR-5, ERR-6; ADR-0021 decision 4): the one place where SDK
 * code is allowed to fail. Every entry point of the SDK (public API, patched fetch / XHR,
 * global handlers, console patch, timers, listeners, OTel processors and exporters, native
 * module calls and callbacks) runs inside `guard.run` or a function made by `guard.wrap`.
 *
 * - An error thrown (or a promise rejected) by SDK code is caught, counted and reported through
 *   the debug logger only. It never reaches the host app.
 * - After `threshold` internal errors since the last `init`, the SDK disables itself: `onDisable`
 *   removes its hooks and every guarded function becomes a no-op that returns its fallback.
 * - Reporting cannot loop: an error thrown by the logger while an error is reported is dropped.
 * - Code the app handed to the SDK (`beforeSend`, `onUnhandledRejection`, ...) runs inside
 *   `guard.host`: its errors are caught and logged but are the app's, so they are not counted.
 *
 * One guard per JS process (the SDK has one instance at a time); `init` resets it.
 */

export const DEFAULT_SELF_DISABLE_THRESHOLD = 20;

export interface GuardOptions {
  /** `diagnostics.selfDisableThreshold`. */
  threshold?: number;
  logger?: DebugLogger;
  /** Called once when the threshold is reached: stop capture and remove every hook. */
  onDisable?: () => void;
}

const state = {
  errors: 0,
  disabled: false,
  threshold: DEFAULT_SELF_DISABLE_THRESHOLD,
  logger: undefined as DebugLogger | undefined,
  onDisable: undefined as (() => void) | undefined,
  reporting: false,
};

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";
}

/** Debug log that cannot throw or re-enter. Never passed a record payload. */
function diagnose(seam: string, err: unknown): void {
  if (state.reporting) return;
  state.reporting = true;
  try {
    state.logger?.warn(`internal error in ${seam}`, err);
  } catch {
    // a broken console must not become a second error
  } finally {
    state.reporting = false;
  }
}

function run<T>(seam: string, fn: () => T): T | undefined;
function run<T>(seam: string, fn: () => T, fallback: T): T;
function run<T>(seam: string, fn: () => T, fallback?: T): T | undefined {
  if (state.disabled) return fallback;
  try {
    const result = fn();
    if (!isThenable(result)) return result;
    // Rejections are internal errors too; the caller gets a promise that settles with the fallback.
    return Promise.resolve(result).then(undefined, (err: unknown) => {
      guard.report(seam, err);
      return isThenable(fallback) ? fallback : undefined;
    }) as unknown as T;
  } catch (err) {
    guard.report(seam, err);
    return fallback;
  }
}

function host<T>(seam: string, fn: () => T): T | undefined;
function host<T>(seam: string, fn: () => T, fallback: T): T;
function host<T>(seam: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (err) {
    diagnose(`${seam} (app callback)`, err);
    return fallback;
  }
}

export const guard = {
  /** New start: zero errors, enabled. Called by `init`. */
  reset(options: GuardOptions = {}): void {
    const t = options.threshold;
    state.errors = 0;
    state.disabled = false;
    state.reporting = false;
    state.threshold = typeof t === "number" && Number.isFinite(t) && t >= 1 ? Math.floor(t) : DEFAULT_SELF_DISABLE_THRESHOLD;
    state.logger = options.logger;
    state.onDisable = options.onDisable;
  },

  /** True once the SDK disabled itself. */
  get disabled(): boolean {
    return state.disabled;
  },

  /** Internal errors counted since the last reset. */
  get errors(): number {
    return state.errors;
  },

  /** Counts one internal error; disables the SDK at the threshold. Never throws. */
  report(seam: string, err: unknown): void {
    state.errors++;
    diagnose(seam, err);
    if (state.disabled || state.errors < state.threshold) return;
    state.disabled = true;
    const onDisable = state.onDisable;
    state.onDisable = undefined;
    try {
      onDisable?.();
    } catch (e) {
      diagnose("self-disable", e);
    }
    diagnose("self-disable", `${state.errors} internal errors: the SDK stopped capture and is now a no-op`);
  },

  /** Runs SDK code. Returns `fallback` when it throws, when its promise rejects, or when the SDK is disabled. */
  run,

  /** `fn` as a function that never throws: the form handed to timers, listeners and patched globals. */
  wrap<A extends unknown[], R>(seam: string, fn: (...args: A) => R, fallback?: R): (...args: A) => R {
    return function guarded(this: unknown, ...args: A): R {
      return run(seam, () => fn.apply(this, args), fallback as R);
    };
  },

  /** Runs a callback the app supplied: caught and logged, not counted. Not skipped when disabled. */
  host,
};

/**
 * A native module whose every method runs inside the guard: a throw or a rejection is counted
 * and the call returns undefined (a resolved promise for a rejection). Property reads keep
 * working for feature detection (`typeof native.postOtlp === "function"`).
 */
export function guardNative<T extends object>(native: T | undefined): T | undefined {
  if (!native || typeof Proxy !== "function") return native;
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(native, {
    get(target, prop) {
      let value: unknown;
      try {
        value = (target as Record<PropertyKey, unknown>)[prop];
      } catch (err) {
        guard.report(`native.${String(prop)}`, err);
        return undefined;
      }
      if (typeof value !== "function") return value;
      let fn = wrapped.get(prop);
      if (!fn) {
        const method = value as (...args: unknown[]) => unknown;
        fn = guard.wrap(`native.${String(prop)}`, (...args: unknown[]) => method.apply(target, args));
        wrapped.set(prop, fn);
      }
      return fn;
    },
  });
}
