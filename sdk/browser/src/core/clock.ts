import { guard } from "../guard";

export type TimerHandle = unknown;

/** Injectable clock so the session manager and chunker can be driven by fake timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Every SDK timer goes through here: an exception in its callback never reaches `window.onerror`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(guard(fn), ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};
