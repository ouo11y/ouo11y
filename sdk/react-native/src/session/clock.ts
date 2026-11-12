import { guard } from "../guard";

export type TimerHandle = unknown;

/** Injectable clock so the session manager can be driven by fake timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The system clock with every timer callback inside the guard (ERR-1): what `init` gives the session manager and the outbox. */
export const guardedClock: Clock = {
  now: systemClock.now,
  setTimeout: (fn, ms) => systemClock.setTimeout(guard.wrap("timer", fn), ms),
  clearTimeout: systemClock.clearTimeout,
};
