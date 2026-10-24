/**
 * The SDK must never break the page it runs on: an exception in SDK code that runs from a
 * page hook (event listener, patched function, observer, timer) is caught here and reported
 * only to the debug logger, so it never reaches `window.onerror`, the page's
 * `unhandledrejection` handlers or the caller of a patched function.
 */

type Report = (err: unknown) => void;

let report: Report | undefined;
let failures = 0;

/** Where contained failures go (the debug logger of the running instance). */
export function setGuardReporter(r: Report | undefined): void {
  report = r;
}

/** Count of SDK exceptions contained since load (tests and the soak read it). */
export function guardedFailures(): number {
  return failures;
}

function swallow(err: unknown): void {
  failures += 1;
  try {
    report?.(err);
  } catch {
    // A failing reporter is contained too.
  }
}

/** Runs `fn`; an exception is contained and `fallback` returned. */
export function attempt<T>(fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch (err) {
    swallow(err);
    return fallback as T;
  }
}

/** Wraps a callback the page or the platform calls (listener, observer, timer) so it never throws. */
export function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return function (this: unknown, ...args: A): void {
    try {
      fn.apply(this, args);
    } catch (err) {
      swallow(err);
    }
  };
}

/** A promise that never rejects: SDK async work must not raise `unhandledrejection` on the page. */
export function quiet(p: Promise<unknown> | undefined): Promise<void> {
  return Promise.resolve(p).then(() => undefined, swallow);
}
