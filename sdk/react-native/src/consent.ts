import { INVALID_SPAN_CONTEXT, trace } from "@opentelemetry/api";
import type { RUMInternal } from "./index";
import type { DebugLogger } from "./logger";
import type { NativeCrashModule } from "./crash";
import { REPLAY_ERRORS_KEY, REPLAY_FEEDBACK_KEY, type NativeReplayModule, type NativeStartOptions } from "./replay";
import { CONTEXT_STORAGE_KEY } from "./errors/context";
import { CRASH_STORAGE_KEY, resetProcessState, SESSION_STORAGE_KEY, USER_STORAGE_KEY } from "./session/manager";
import { Outbox } from "./transport/outbox";
import type { AsyncKeyValueStorage, Consent, ConsentState, LogFn, LogLevel, RUMLog } from "./types";

/** Public API calls kept while consent is pending; the oldest is dropped beyond it. */
export const CONSENT_QUEUE_LIMIT = 100;

/** The `storage` keys the SDK writes, besides the outbox's (`ouo.outbox`, `ouo.outbox.<id>`). */
export const STORAGE_KEYS = [SESSION_STORAGE_KEY, USER_STORAGE_KEY, CRASH_STORAGE_KEY, CONTEXT_STORAGE_KEY, REPLAY_ERRORS_KEY, REPLAY_FEEDBACK_KEY];

/** A running SDK: what `install` in ./index.ts returns. */
export type Installed = Omit<RUMInternal, "setConsent" | "getConsent"> & {
  /** Consent revoked: stop with no upload, delete the stored requests and held replay chunks, uninstall. */
  _revoke(): Promise<void>;
  /** Replay consent: the native recorder's own switch (src/replay.ts `setAllowed`). */
  _setReplayAllowed(allowed: boolean): void;
};

/** What the app asked of replay before the grant, applied before the recorder starts. */
export interface ReplayIntent {
  allowed: boolean;
  paused: boolean;
  hidden: boolean;
}

const LEVELS: Array<Exclude<LogLevel, never>> = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * Consent in front of the SDK (README, "Consent"; docs/specs/session-lifecycle.md). Nothing runs
 * until telemetry is granted: `start` installs everything and is the only path to `storage`, the
 * native module and the network. Calls made meanwhile wait in memory and run at the grant,
 * stamped at that time; of the screen views only the last is kept (the screen the user is on).
 */
export function createConsentGate(opts: {
  start: (replay: ReplayIntent) => Installed | undefined;
  /** Removes what the SDK stored when no instance runs (refused at launch). */
  wipe: () => Promise<void>;
  logger: DebugLogger;
  onShutdown: () => void;
  /** Started already: consent granted at `initRUM`. Undefined: pending. */
  running?: Installed | undefined;
}): RUMInternal {
  const { start, logger } = opts;
  let inner = opts.running;
  let status: ConsentState["status"] = inner ? "granted" : "pending";
  let replayAllowed = inner !== undefined;
  let paused = false;
  let hidden = false;
  let closed = false;
  /** The grant's install failed: the SDK is off, calls are dropped rather than queued. */
  let failed = false;
  let queue: Array<{ nav: boolean; run: (rum: Installed) => void }> = [];
  let dropped = 0;
  let chain: Promise<void> = Promise.resolve();
  let readyResolve: () => void = () => undefined;
  const ready = inner ? inner.ready : new Promise<void>((resolve) => (readyResolve = resolve));

  const call = (run: (rum: Installed) => void, nav = false): void => {
    if (inner) return run(inner);
    if (closed || failed || status === "denied") return;
    if (nav) queue = queue.filter((q) => !q.nav);
    if (queue.length >= CONSENT_QUEUE_LIMIT) {
      queue.shift();
      if (dropped++ === 0) logger.warn(`consent pending: over ${CONSENT_QUEUE_LIMIT} calls, dropping the oldest`);
    }
    queue.push({ nav, run });
  };
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn("consent: a queued call failed", err);
    }
  };

  const setConsent = (consent: Consent): Promise<void> => {
    if (closed) return chain;
    const telemetry = consent?.telemetry === true;
    const replay = telemetry && consent.replay === true;
    if (!telemetry) {
      queue = [];
      dropped = 0;
      replayAllowed = false;
      status = "denied";
      failed = false;
      const prev = inner;
      inner = undefined;
      logger.log("consent revoked: stopping, deleting the stored session, requests and held replay");
      // The old instance persists its session while it stops: wipe after it.
      return (chain = chain
        .then(() => prev?._revoke())
        .catch((err: unknown) => logger.warn("consent: revoke failed", err))
        .then(() => opts.wipe())
        .catch((err: unknown) => logger.warn("consent: wipe failed", err)));
    }
    const changed = replay !== replayAllowed;
    replayAllowed = replay;
    if (inner) {
      if (changed) inner._setReplayAllowed(replay);
      return Promise.resolve();
    }
    if (status === "granted") return chain; // its start, waiting for a revocation, reads replayAllowed
    status = "granted";
    return (chain = chain.then(() => {
      if (closed || status !== "granted" || inner) return;
      logger.log("consent granted", { replay: replayAllowed, queued: queue.length, dropped });
      inner = start({ allowed: replayAllowed, paused, hidden });
      const pending = queue;
      queue = [];
      dropped = 0;
      const rum = inner;
      if (!rum) {
        failed = true;
        return;
      }
      void rum.ready.then(readyResolve, readyResolve);
      for (const q of pending) safely(() => q.run(rum));
    }));
  };

  const log = ((level: LogLevel, message: string, attrs, options) => call((r) => r.log(level, message, attrs, options))) as RUMLog;
  for (const level of LEVELS) {
    const fn: LogFn = (message, attrs, options) => call((r) => r.log[level](message, attrs, options));
    log[level] = fn;
  }
  // No session before consent: a span would belong to none and is never exported.
  const noSpan = () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

  const gate: RUMInternal = {
    setUser: (user) => call((r) => r.setUser(user)),
    captureError: (err, context) => call((r) => r.captureError(err, context)),
    addEvent: (name, attrs) => call((r) => r.addEvent(name, attrs)),
    trackNavigation: (path, attrs) => call((r) => r.trackNavigation(path, attrs), true),
    // Activity, taps and display timing before a session exist: not recorded.
    recordActivity: () => inner?.recordActivity(),
    trackTap: (target, path, gesture) => inner?.trackTap(target, path, gesture),
    reportFullyDisplayed: () => inner?.reportFullyDisplayed(),
    startSpan: (name, options) => (inner ? inner.startSpan(name, options) : noSpan()),
    withSpan: (name, fn, options) => (inner ? inner.withSpan(name, fn, options) : fn(noSpan())),
    log,
    feedback: (input) => {
      if (inner) return inner.feedback(input);
      logger.warn("feedback before telemetry consent: not sent");
      return undefined;
    },
    replay: {
      pause: () => {
        paused = true;
        inner?.replay.pause();
      },
      resume: () => {
        paused = false;
        inner?.replay.resume();
      },
      isRecording: () => inner?.replay.isRecording() ?? false,
      hideScreen: () => {
        hidden = true;
        inner?.replay.hideScreen();
      },
      showScreen: () => {
        hidden = false;
        inner?.replay.showScreen();
      },
    },
    session: {
      id: () => inner?.session.id() ?? "",
      userId: () => inner?.session.userId() ?? "",
      previousId: () => inner?.session.previousId(),
    },
    ready,
    flush: () => inner?.flush() ?? Promise.resolve(),
    setConsent,
    getConsent: () => ({ status, telemetry: status === "granted", replay: status === "granted" && replayAllowed }),
    _rootMounted: () => inner?._rootMounted(),
    _touchStart: (event, touched) => inner?._touchStart(event, touched),
    _touchEnd: (event) => inner?._touchEnd(event),
    _uninstall: () => {
      if (!closed) {
        closed = true;
        queue = [];
        const prev = inner;
        inner = undefined;
        readyResolve();
        chain = chain
          .then(() => prev?._uninstall())
          .catch((err: unknown) => logger.warn("uninstall failed", err))
          .then(opts.onShutdown);
      }
      return chain;
    },
  };
  return gate;
}

/**
 * Deletes what the SDK stored in `storage`: the session, the user, the crash marker, the error
 * context, the replay tallies and every stored request (read from the outbox's index). Never rejects.
 */
export async function wipeStorage(storage: AsyncKeyValueStorage, logger: DebugLogger): Promise<void> {
  resetProcessState();
  const outbox = new Outbox({ storage, send: () => Promise.resolve({ status: 0 }), logger });
  await Promise.all([outbox.clear(), ...STORAGE_KEYS.map((k) => storage.removeItem(k).catch(() => undefined))]);
}

/**
 * Deletes what the native module keeps from an earlier run, unsent: the pending crash or
 * termination report (taken and dropped) and the replay chunks held for `keepAtNextLaunch`. Runs
 * at every revocation, including a refusal at launch when no instance ever ran. The chunk a crash
 * left open has no native discard call yet (project/kb/consent.md, "Remainder"). Never rejects.
 */
export async function wipeNative(
  native: (NativeReplayModule & NativeCrashModule) | undefined,
  endpoint: string | undefined,
  options: NativeStartOptions,
  logger: DebugLogger,
): Promise<void> {
  if (!native) return;
  try {
    native.takePendingCrash?.();
  } catch (err) {
    logger.warn("consent: takePendingCrash failed", err);
  }
  if (!endpoint || typeof native.heldReplaySessions !== "function" || typeof native.releaseHeldReplay !== "function") return;
  try {
    for (const h of await native.heldReplaySessions(endpoint, options)) native.releaseHeldReplay(endpoint, options, h.sessionId, false);
  } catch (err) {
    logger.warn("consent: deleting held replay failed", err);
  }
}
