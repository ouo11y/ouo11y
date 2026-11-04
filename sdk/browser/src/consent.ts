import { attempt, quiet } from "./guard";
import type { DebugLogger } from "./logger";
import { DEVICE_STORAGE_KEY } from "./session/device";
import { SESSION_STORAGE_KEY, USER_STORAGE_KEY } from "./session/manager";
import type { Consent, ConsentState, DeliveryStats, RUM } from "./types";

/** Public API calls kept while consent is pending; the oldest is dropped beyond it. */
export const CONSENT_QUEUE_LIMIT = 100;

/** Every `localStorage` key the SDK writes; only these (an app may use `ouo.` keys of its own). */
const STORAGE_KEYS = [DEVICE_STORAGE_KEY, SESSION_STORAGE_KEY, USER_STORAGE_KEY, "ouo.probe"];
/** The offline outbox (src/transport/store.ts `IDB_NAME`). */
const OUTBOX_DB = "ouo-delivery";
/** A delete blocked by a connection that never closes must not hold up a later grant for ever. */
const DELETE_TIMEOUT_MS = 3000;

/** A running SDK: what `install` in ./index.ts returns. */
export interface Installed extends Omit<RUM, "setConsent" | "getConsent"> {
  /** Consent revoked: stop with no network call and no store write, then uninstall. */
  _revoke(): Promise<void>;
  _uninstall(): Promise<void>;
}

export type Gated = RUM & {
  _uninstall(): Promise<void>;
  /** Another tab revoked consent: stop here too, without a second wipe. */
  _revokedElsewhere?(): void;
};

const noStats = (): DeliveryStats => ({ sent: 0, retried: 0, queued: 0, dropped: 0, droppedBytes: 0, dropReasons: {}, rawBytes: 0, wireBytes: 0 });

/**
 * Consent in front of the SDK (README, "Consent"; docs/specs/session-lifecycle.md). Nothing runs
 * until telemetry is granted: `start` installs everything and is the only path to storage,
 * IndexedDB, BroadcastChannel and the network, so a pending SDK cannot touch them. Calls made
 * meanwhile wait in memory and run at the grant, stamped at that time (an event hours old would
 * fall behind Loki's out-of-order window). Replay consent drives the recorder's pause, kept apart
 * from the app's own `replay.pause()`.
 */
export function createConsentGate(
  start: (replay: boolean) => Installed | undefined,
  logger: DebugLogger,
  onShutdown: () => void,
  /** Started already: consent granted at `initRUM`. Undefined: pending. */
  running?: Installed,
): Gated {
  let status: ConsentState["status"] = running ? "granted" : "pending";
  let replayAllowed = running !== undefined;
  let appPaused = false;
  let closed = false;
  /** The grant's install failed: the SDK is off, calls are dropped rather than queued. */
  let failed = false;
  /** A revocation happened: the next grant wipes first, so it never resumes a pre-revocation session. */
  let revoked = false;
  let queue: Array<(rum: Installed) => void> = [];
  let dropped = 0;
  /** The last revocation or grant: the next one runs after it (the old instance persists its session while it stops). */
  let chain: Promise<void> = Promise.resolve();
  let inner = running;

  const call = (fn: (rum: Installed) => void): void => {
    if (inner) return fn(inner);
    if (closed || failed || status === "denied") return;
    // Pending, or granted while a revocation finishes: kept for the instance about to start.
    if (queue.length >= CONSENT_QUEUE_LIMIT) {
      queue.shift();
      if (dropped++ === 0) logger.warn("consent pending: queue full, oldest dropped");
    }
    queue.push(fn);
  };

  /** Stops the running instance; `wipeAfter` removes what the SDK stored (not when another tab did). */
  const revoke = (wipeAfter: boolean): Promise<void> => {
    queue = [];
    dropped = 0;
    replayAllowed = false;
    status = "denied";
    revoked = true;
    failed = false;
    const prev = inner;
    inner = undefined;
    logger.log("consent revoked", wipeAfter ? "here" : "in another tab");
    chain = chain.then(() => quiet(prev?._revoke()));
    if (wipeAfter) chain = chain.then(wipe);
    return chain;
  };

  const setConsent = (consent: Consent): Promise<void> => {
    if (closed) return chain;
    const telemetry = consent?.telemetry === true;
    const replay = telemetry && consent.replay === true;
    if (!telemetry) return revoke(true);
    const replayChanged = replay !== replayAllowed;
    replayAllowed = replay;
    if (inner) {
      if (replayChanged) {
        if (replay && !appPaused) inner.replay.resume();
        else inner.replay.pause();
      }
      return Promise.resolve();
    }
    // Granted already, its start waiting for a revocation to finish: it reads `replayAllowed` then.
    if (status === "granted") return chain;
    status = "granted";
    return (chain = chain
      // Another tab may have written the old session back before it stopped: never resume it.
      .then(() => (revoked ? wipe() : undefined))
      .then(() => {
        if (closed || status !== "granted" || inner) return;
        logger.log("consent granted", { replay: replayAllowed, queued: queue.length, dropped });
        inner = start(replayAllowed && !appPaused);
        if (!inner) {
          failed = true;
          queue = [];
          return;
        }
        const pending = queue;
        queue = [];
        dropped = 0;
        for (const fn of pending) {
          const rum = inner;
          if (rum) attempt(() => fn(rum));
        }
      }));
  };

  const gated: Gated = {
    setUser: (user) => call((r) => r.setUser(user)),
    clearUser: () => call((r) => r.clearUser()),
    // No session before consent: nothing to end.
    endSession: () => inner?.endSession(),
    captureError: (err, context) => call((r) => r.captureError(err, context)),
    addEvent: (name, attrs) => call((r) => r.addEvent(name, attrs)),
    setRoute: (name) => call((r) => r.setRoute(name)),
    replay: {
      pause: () => {
        appPaused = true;
        inner?.replay.pause();
      },
      resume: () => {
        appPaused = false;
        if (replayAllowed) inner?.replay.resume();
      },
      isRecording: () => inner?.replay.isRecording() ?? false,
    },
    session: {
      id: () => inner?.session.id() ?? "",
      userId: () => inner?.session.userId() ?? "",
      deviceId: () => inner?.session.deviceId() ?? "",
    },
    setConsent,
    getConsent: () => ({ status, telemetry: status === "granted", replay: status === "granted" && replayAllowed }),
    flush: () => inner?.flush() ?? Promise.resolve(),
    shutdown: () => {
      if (!closed) {
        closed = true;
        queue = [];
        const prev = inner;
        inner = undefined;
        chain = chain.then(() => quiet(prev?._uninstall())).then(onShutdown);
      }
      return chain;
    },
    _uninstall: () => gated.shutdown(),
    _revokedElsewhere: () => {
      if (!closed && inner) void revoke(false);
    },
    deliveryStats: () => inner?.deliveryStats() ?? noStats(),
  };
  return gated;
}

/**
 * Removes what the SDK stored: its `localStorage` keys and the IndexedDB outbox. Open
 * connections to the outbox (this tab's, shut down by now, and other tabs') close on the
 * delete's `versionchange` (src/transport/store.ts). Never throws.
 */
export function wipe(): Promise<void> {
  attempt(() => {
    for (const k of STORAGE_KEYS) globalThis.localStorage.removeItem(k);
  });
  return new Promise<void>((resolve) => {
    const req = attempt(() => globalThis.indexedDB?.deleteDatabase(OUTBOX_DB));
    if (!req) return resolve();
    const timer = setTimeout(done, DELETE_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      resolve();
    }
    req.onsuccess = done;
    req.onerror = done;
  });
}
