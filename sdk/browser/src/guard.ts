/**
 * The golden rule: the app must not pay for the SDK's failures (ERR-1). An exception in SDK code
 * that runs from a page hook (event listener, patched function, observer, timer, public method)
 * is caught here, counted, and reported only to the debug logger, so it never reaches
 * `window.onerror`, the page's `unhandledrejection` handlers or the caller of a patched function.
 * After `threshold` contained failures the SDK turns itself off (ERR-6).
 */

type Report = (err: unknown) => void;

let report: Report | undefined;
let failures = 0;
let threshold = Infinity;
let onThreshold: (() => void) | undefined;
let tripped = false;

/** Fault injection for tests (GR-CRASH-7): a named SDK internal throws while its name is set. */
const faults = new Set<string>();

/** Wires the running instance in: where failures are logged and what happens at the threshold. */
export function configureGuard(o: { report?: Report; threshold?: number; onThreshold?: () => void } | undefined): void {
  report = o?.report;
  threshold = o?.threshold ?? Infinity;
  onThreshold = o?.onThreshold;
  failures = 0;
  tripped = false;
}

/** Count of SDK exceptions contained since the last `init` (tests and the soak read it). */
export function guardedFailures(): number {
  return failures;
}

/** Test hook: make `point(name)` throw inside the SDK. Never set by the SDK itself. */
export function injectFault(name: string, on = true): void {
  if (on) faults.add(name);
  else faults.delete(name);
}

/** A named place inside the SDK where a test can inject a failure. A set lookup otherwise. */
export function point(name: string): void {
  if (faults.size > 0 && (faults.has(name) || faults.has("*"))) throw new Error(`[ouo] injected fault: ${name}`);
}

export function contain(err: unknown): void {
  failures += 1;
  try {
    report?.(err);
  } catch {
    // A failing reporter is contained too.
  }
  if (!tripped && failures >= threshold) {
    tripped = true;
    try {
      onThreshold?.();
    } catch {
      // Turning off must not throw either.
    }
  }
}

/** Runs `fn`; an exception is contained and `fallback` returned. */
export function attempt<T>(fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch (err) {
    contain(err);
    return fallback as T;
  }
}

/** Wraps a callback the page or the platform calls (listener, observer, timer) so it never throws. */
export function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return function (this: unknown, ...args: A): void {
    try {
      fn.apply(this, args);
    } catch (err) {
      contain(err);
    }
  };
}

/** A promise that never rejects: SDK async work must not raise `unhandledrejection` on the page. */
export function quiet(p: Promise<unknown> | undefined | void): Promise<void> {
  return Promise.resolve(p).then(() => undefined, contain);
}

/** `addEventListener` with a guarded handler; returns the remover. */
export function listen(target: EventTarget | undefined | null, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions | boolean): () => void {
  if (!target || typeof target.addEventListener !== "function") return () => undefined;
  const safe = guard(fn);
  target.addEventListener(type, safe, options);
  return () => attempt(() => target.removeEventListener(type, safe, options));
}
