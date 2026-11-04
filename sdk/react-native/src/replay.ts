import type { DebugLogger } from "./logger";
import { SAMPLING_SALT, sampled, sampleRate } from "./sampling";
import type { AsyncKeyValueStorage, HeldReplaySession, ReplayMode, ReplayOptions, RUMReplay } from "./types";

/**
 * Shape of the Expo native module `OuoReplay` (sdk/react-native/ios/OuoReplayModule.swift,
 * android/src/main/java/dev/ouo/reactnative/OuoReplayModule.kt). Every function is synchronous except `flush`.
 */
export interface NativeReplayModule {
  start(endpoint: string, options: NativeStartOptions): void;
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  flush(): Promise<void>;
  sessionDidRotate(id: string): void;
  setSessionId(id: string): void;
  /** Missing on native builds older than the replay modes. */
  screenDidChange?(): void;
  /** Sends the chunk a crash left open in the previous run; missing on older native builds. */
  recoverPendingChunk?(endpoint: string, options: NativeStartOptions): void;
  stop?(): void;
  /** Finished sessions whose chunks the device holds (`holdUploads`); missing on older native builds. */
  heldReplaySessions?(endpoint: string, options: NativeStartOptions): Promise<NativeHeldSession[]>;
  /** Sends (`keep`) or deletes a held session's chunks. */
  releaseHeldReplay?(endpoint: string, options: NativeStartOptions, sessionId: string, keep: boolean): void;
}

export interface NativeHeldSession {
  sessionId: string;
  chunks: number;
  bytes: number;
  firstAt: number;
  lastAt: number;
}

/** Options the native `start` receives; mirrors `OuoReplayConfig` (docs/specs/mobile-replay.md). */
export interface NativeStartOptions {
  sessionId: string;
  /**
   * Project credential (ADR-0007): the native uploader sends
   * `Authorization: Basic base64("<projectId>:<projectToken>")` on every chunk upload.
   */
  projectId: string;
  projectToken: string;
  mode: ReplayMode;
  frameInterval: number;
  maskText: boolean;
  maskInputs: boolean;
  maskImages: boolean;
  maskWebViews: boolean;
  debug: boolean;
  /** Keep chunks on the device until `releaseHeldReplay` (set when `replay.keepAtNextLaunch` is). */
  holdUploads: boolean;
}

export const NATIVE_MODULE_NAME = "OuoReplay";

/** Capture comes back this long after a never-record screen was left (or `showScreen()`), when the transition is over. */
export const SHOW_DELAY_MS = 500;

/**
 * Loads the Expo native module. Returns undefined in Expo Go, on web, in Node and in tests
 * (anywhere `expo-modules-core` is missing or the module is not linked); the caller then runs
 * a no-op controller. The require is guarded so a bare React Native app without Expo still
 * bundles: Metro resolves the literal module name, so hosts without `expo-modules-core` must
 * alias it (see the README).
 */
/** Why the last `loadNativeReplayModule()` returned undefined; surfaced in the debug warning. */
export let lastNativeLoadError: string | undefined;

export function loadNativeReplayModule(): NativeReplayModule | undefined {
  lastNativeLoadError = undefined;
  try {
    // Expo registers every native module on `globalThis.expo.modules`; reading it directly avoids a
    // `require("expo-modules-core")` that Metro cannot resolve when this package is symlinked from
    // outside the app (npm workspaces, `file:` links). The require is only a fallback.
    const registry = (globalThis as { expo?: { modules?: Record<string, NativeReplayModule> } }).expo?.modules;
    let mod: NativeReplayModule | undefined = registry?.[NATIVE_MODULE_NAME];
    if (!mod) {
      const core = expoModulesCore();
      if (!core || typeof core.requireNativeModule !== "function") {
        lastNativeLoadError = "native module not registered and expo-modules-core not resolvable";
        return undefined;
      }
      mod = core.requireNativeModule(NATIVE_MODULE_NAME);
    }
    if (!mod || typeof mod.start !== "function") {
      lastNativeLoadError = `native module has no start(): keys=${Object.keys(mod ?? {}).join(",")}`;
      return undefined;
    }
    return mod;
  } catch (err) {
    const registered = Object.keys((globalThis as { expo?: { modules?: object } }).expo?.modules ?? {});
    lastNativeLoadError = `${err instanceof Error ? err.message : String(err)} (registered: ${registered.join(",") || "none"})`;
    return undefined;
  }
}

interface ExpoModulesCoreLike {
  requireNativeModule?: (name: string) => NativeReplayModule;
}

let expoModulesCore: () => ExpoModulesCoreLike | undefined = () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("expo-modules-core") as ExpoModulesCoreLike | undefined;

/** Test hook: Vitest aliases `import`s but not this bare `require`, so tests inject the mock. */
export function _setExpoModulesCore(resolver: (() => ExpoModulesCoreLike | undefined) | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expoModulesCore = resolver ?? (() => require("expo-modules-core") as ExpoModulesCoreLike | undefined);
}

export interface ReplayControllerOptions {
  /** Replay receiver base URL (the collector's `ouoreplay` port); chunks go to `${endpoint}/v1/replay/chunks`. */
  endpoint: string | undefined;
  /** Project credential the native uploader turns into the Basic `Authorization` header. */
  projectId: string;
  projectToken: string;
  options: ReplayOptions | undefined;
  /** `session.sampleRate`: a session outside it is never recorded. Default 1. */
  sessionSampleRate?: number;
  /** Injected for tests; `undefined` means "load from expo-modules-core", `null` means "absent". */
  native?: NativeReplayModule | null;
  /** Where the error counts of held sessions persist (`replay.keepAtNextLaunch`). */
  storage?: AsyncKeyValueStorage;
  /** Capture stopped for a never-record screen (`screen`) or `hideScreen()` (`manual`) while the session records. */
  onHidden?: (reason: "screen" | "manual") => void;
  logger: DebugLogger;
}

/**
 * Whether a navigation `path` (`/Account/IdentityCheck`) or its screen name (the last segment)
 * matches one of `replay.excludeScreens`: exact, a prefix when the string ends with `*`, or a RegExp.
 */
export function screenExcluded(patterns: Array<string | RegExp> | undefined, path: string): boolean {
  if (!patterns || !path) return false;
  const values = [path, path.slice(path.lastIndexOf("/") + 1)];
  return patterns.some((p) =>
    values.some((v) => {
      if (typeof p !== "string") {
        p.lastIndex = 0;
        return p.test(v);
      }
      return p.endsWith("*") ? v.startsWith(p.slice(0, -1)) : v === p;
    }),
  );
}

/** What `initRUM` drives; `RUMReplay` is the public subset exposed as `rum.replay`. */
export interface ReplayController extends RUMReplay {
  /** True when the native recorder was started. */
  readonly active: boolean;
  start(sessionId: string): void;
  sessionDidRotate(id: string): void;
  /** A new screen is showing: the frame for it in `navigation` mode. */
  screenDidChange(): void;
  /** The navigation path of the screen now showing: capture stops while it matches `replay.excludeScreens`. */
  setScreen(path: string): void;
  /** A feedback in the current session (C10): counted for `keepAtNextLaunch`. */
  onFeedback(): void;
  /** An error in the current session: starts an error-triggered recording when sampled. */
  onError(): void;
  flush(): Promise<void>;
  stop(): void;
  /**
   * Next-launch keep/drop: asks `replay.keepAtNextLaunch` about every held session but
   * `currentId` and sends or deletes its chunks (all are sent when the hook is not set, so
   * nothing stays behind after the hook is removed). `crashedId` is the session that crashed.
   */
  decideHeld(currentId: string, crashedId: string | undefined): Promise<void>;
  /**
   * Replay consent (README, "Consent"): withheld, the native recorder is never started, or is
   * paused, whatever sampling, `resume()` or `showScreen()` say. Default given.
   */
  setAllowed(allowed: boolean): void;
  /** Consent revoked: deletes the replay chunks the device holds (`keepAtNextLaunch`) unsent. */
  discardHeld(): Promise<void>;
}

export const REPLAY_ERRORS_KEY = "ouo.replay.errors";
export const REPLAY_FEEDBACK_KEY = "ouo.replay.feedback";

/** A count per session (exceptions, feedback), persisted under `key` so the next launch can tell `keepAtNextLaunch`. */
function sessionTally(storage: AsyncKeyValueStorage | undefined, key: string): { add(id: string): void; take(keepId: string): Promise<Record<string, number>> } {
  let counts: Promise<Record<string, number>> = storage
    ? storage.getItem(key).then(
        (raw) => {
          try {
            const v = JSON.parse(raw ?? "{}") as Record<string, number>;
            return v && typeof v === "object" ? v : {};
          } catch {
            return {};
          }
        },
        () => ({}),
      )
    : Promise.resolve({});
  const save = (c: Record<string, number>): Record<string, number> => {
    void storage?.setItem(key, JSON.stringify(c)).catch(() => undefined);
    return c;
  };
  return {
    add(id) {
      counts = counts.then((c) => save({ ...c, [id]: (c[id] ?? 0) + 1 }));
    },
    take(keepId) {
      const all = counts;
      counts = counts.then((c) => save(c[keepId] ? { [keepId]: c[keepId]! } : {}));
      return all;
    },
  };
}

/**
 * Bridges `initRUM({ replay })` and the session manager to the native recorder. Replay is off
 * unless `replay.enabled === true` (ADR-0006: "Replay is off until the host enables it").
 *
 * Sampling (8b): a session is recorded when it is in the session sample and in the replay
 * sample (`replay.sampleRate`), or, failing the latter, from its first error when it is in
 * the on-error sample (`replay.onErrorSampleRate`). The native recorder is started for the
 * first recorded session and paused for sessions that are not recorded.
 */
/** What the native `start` (and the held-chunk calls) receive for `sessionId`. */
export function nativeStartOptions(
  opts: Pick<ReplayControllerOptions, "projectId" | "projectToken" | "options">,
  debug: boolean,
  sessionId: string,
): NativeStartOptions {
  return {
    sessionId,
    projectId: opts.projectId,
    projectToken: opts.projectToken,
    mode: opts.options?.mode ?? "auto",
    frameInterval: opts.options?.frameInterval ?? 1,
    maskText: opts.options?.maskText !== false,
    maskInputs: opts.options?.maskInputs !== false,
    maskImages: opts.options?.maskImages !== false,
    maskWebViews: opts.options?.maskWebViews !== false,
    debug,
    holdUploads: typeof opts.options?.keepAtNextLaunch === "function",
  };
}

export function createReplayController(opts: ReplayControllerOptions): ReplayController {
  const { logger } = opts;
  const enabled = opts.options?.enabled === true;
  const native = enabled ? (opts.native === undefined ? loadNativeReplayModule() : opts.native ?? undefined) : undefined;
  const endpoint = opts.endpoint;
  const sessionRate = sampleRate(opts.sessionSampleRate, 1);
  const replayRate = sampleRate(opts.options?.sampleRate, 1);
  const onErrorRate = sampleRate(opts.options?.onErrorSampleRate, 0);
  let active = false;
  let currentId: string | undefined;
  /** The host called `rum.replay.pause()`. */
  let userPaused = false;
  /** Replay consent (`setAllowed`): withheld, the recorder is never started, or is paused. */
  let allowed = true;
  /** Held by the host: `pause()` or no replay consent. */
  const stopped = (): boolean => userPaused || !allowed;
  /** Paused because the current session is not recorded. */
  let samplePaused = false;
  /** The current session started recording at an error. */
  let errorTriggered = false;
  /** The screen showing matches `excludeScreens`. */
  let screenHidden = false;
  /** The host called `rum.replay.hideScreen()`. */
  let manualHidden = false;
  /** Pending end of a hidden stretch (`SHOW_DELAY_MS`): capture stays paused until it fires. */
  let showing: ReturnType<typeof setTimeout> | undefined;
  /** The session to start the native recorder for once nothing hides the screen. */
  let pendingStart: string | undefined;
  const hidden = (): boolean => screenHidden || manualHidden || showing !== undefined;
  const excludeScreens = opts.options?.excludeScreens;
  const keepHook = opts.options?.keepAtNextLaunch;
  const hold = typeof keepHook === "function";
  const tally = sessionTally(hold ? opts.storage : undefined, REPLAY_ERRORS_KEY);
  const feedbackTally = sessionTally(hold ? opts.storage : undefined, REPLAY_FEEDBACK_KEY);

  if (enabled && !native) {
    // One line, debug only: Expo Go, web and Jest/Vitest all land here.
    logger.warn(`replay: native module OuoReplay unavailable (Expo Go, web or a build without the dev client); replay disabled. ${lastNativeLoadError ?? ""}`);
  }
  if (enabled && native && !endpoint) {
    logger.warn("replay: no replay endpoint; replay disabled");
  }

  const call = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn(`replay: native ${what} failed`, err);
    }
  };
  const inSessionSample = (id: string): boolean => sampled(id, sessionRate, SAMPLING_SALT.session);
  const recorded = (id: string): boolean => inSessionSample(id) && sampled(id, replayRate, SAMPLING_SALT.replay);

  const nativeOptions = (sessionId: string): NativeStartOptions => nativeStartOptions(opts, logger.enabled, sessionId);

  // The chunk a crash left open goes out whatever this launch's sampling decides.
  if (native && endpoint && typeof native.recoverPendingChunk === "function") {
    call("recoverPendingChunk", () => native.recoverPendingChunk!(endpoint, nativeOptions("")));
  }

  const hiddenReason = (): "screen" | "manual" => (screenHidden ? "screen" : "manual");

  const startNative = (sessionId: string): void => {
    if (!native || !endpoint || active) return;
    // No replay consent: started once it is given (`setAllowed`).
    if (!allowed) {
      pendingStart = sessionId;
      return;
    }
    // Native start takes a frame at once: on a hidden screen, start once it is shown.
    if (hidden()) {
      if (pendingStart !== sessionId && !stopped()) opts.onHidden?.(hiddenReason());
      pendingStart = sessionId;
      return;
    }
    pendingStart = undefined;
    const startOptions = nativeOptions(sessionId);
    call("start", () => {
      native.setSessionId(sessionId);
      native.start(endpoint, startOptions);
      active = true;
      logger.log("replay: started", { endpoint, ...startOptions, projectToken: `${opts.projectToken.slice(0, 8)}…` });
    });
    if (active && stopped()) call("pause", () => native.pause());
  };

  /** The hidden stretch is over: start or resume what it held back. */
  const show = (): void => {
    if (hidden() || !native) return;
    if (!active) {
      if (pendingStart !== undefined) startNative(pendingStart);
      return;
    }
    if (samplePaused || stopped()) return;
    call("resume", () => native.resume());
    logger.log("replay: shown");
  };

  /**
   * Never-record screens and `hideScreen()`: a third pause source next to the host's pause and
   * the sampling pause. Native pause runs on the main thread's next turn (the open chunk is cut).
   * Capture comes back `SHOW_DELAY_MS` after nothing hides the screen any more, with a full frame:
   * a JS-driven stack transition (and any transition on Android, which has no transition check)
   * would otherwise capture the never-record screen sliding out.
   */
  const setHidden = (screen: boolean, manual: boolean, reason: "screen" | "manual"): void => {
    const was = screenHidden || manualHidden;
    screenHidden = screen;
    manualHidden = manual;
    const now = screenHidden || manualHidden;
    if (was === now) return;
    if (!now) {
      showing = setTimeout(() => {
        showing = undefined;
        show();
      }, SHOW_DELAY_MS);
      return;
    }
    if (showing !== undefined) {
      // Hidden again before the delay ran out: still the same paused stretch.
      clearTimeout(showing);
      showing = undefined;
      return;
    }
    if (!native || !active || samplePaused || stopped()) return;
    call("pause", () => native.pause());
    logger.log(`replay: hidden (${reason})`);
    opts.onHidden?.(reason);
  };

  return {
    get active() {
      return active;
    },
    start(sessionId: string): void {
      if (!native || !endpoint || active) return;
      currentId = sessionId;
      if (recorded(sessionId)) {
        startNative(sessionId);
      } else {
        logger.log("replay: session not in the replay sample", sessionId);
      }
    },
    sessionDidRotate(id: string): void {
      if (!native) return;
      // The manager also reports the initial session (cold start resolution): same id, nothing to do.
      if (id === currentId) return;
      currentId = id;
      errorTriggered = false;
      if (!active) {
        pendingStart = undefined;
        if (recorded(id)) startNative(id);
        return;
      }
      call("sessionDidRotate", () => native.sessionDidRotate(id));
      logger.log("replay: session rotated", id);
      if (!recorded(id)) {
        if (!samplePaused && !stopped() && !hidden()) call("pause", () => native.pause());
        samplePaused = true;
        logger.log("replay: session not in the replay sample", id);
        return;
      }
      if (samplePaused) {
        samplePaused = false;
        if (!stopped() && !hidden()) call("resume", () => native.resume());
      }
      // The new session starts on a hidden screen: its timeline gets the marker too.
      if (hidden() && !stopped()) opts.onHidden?.(hiddenReason());
    },
    screenDidChange(): void {
      if (!native || !active || !native.screenDidChange || hidden()) return;
      call("screenDidChange", () => native.screenDidChange!());
    },
    setScreen(path: string): void {
      setHidden(screenExcluded(excludeScreens, path), manualHidden, "screen");
    },
    hideScreen(): void {
      setHidden(screenHidden, true, "manual");
    },
    showScreen(): void {
      setHidden(screenHidden, false, "manual");
    },
    onFeedback(): void {
      if (hold && currentId !== undefined) feedbackTally.add(currentId);
    },
    onError(): void {
      const id = currentId;
      if (hold && id !== undefined) tally.add(id);
      if (!native || !endpoint || id === undefined || errorTriggered) return;
      if (!inSessionSample(id) || recorded(id) || !sampled(id, onErrorRate, SAMPLING_SALT.replayOnError)) return;
      errorTriggered = true;
      logger.log("replay: recording triggered by an error", id);
      if (!active) {
        startNative(id);
      } else if (samplePaused) {
        samplePaused = false;
        if (!stopped() && !hidden()) call("resume", () => native.resume());
      }
    },
    pause(): void {
      userPaused = true;
      if (!native || !active || samplePaused || hidden() || !allowed) return;
      call("pause", () => native.pause());
    },
    resume(): void {
      userPaused = false;
      if (!native || !active || samplePaused || hidden() || !allowed) return;
      call("resume", () => native.resume());
    },
    setAllowed(next: boolean): void {
      if (next === allowed) return;
      const wasStopped = stopped();
      allowed = next;
      logger.log(`replay: consent ${next ? "given" : "withdrawn"}`);
      if (!native || !endpoint) return;
      if (!active) {
        if (next && pendingStart !== undefined) startNative(pendingStart);
        return;
      }
      if (samplePaused || hidden() || wasStopped === stopped()) return;
      if (next) call("resume", () => native.resume());
      else call("pause", () => native.pause());
    },
    async discardHeld(): Promise<void> {
      if (!native || !endpoint || typeof native.heldReplaySessions !== "function" || typeof native.releaseHeldReplay !== "function") return;
      try {
        const held = await native.heldReplaySessions(endpoint, nativeOptions(""));
        for (const h of held) call("releaseHeldReplay", () => native.releaseHeldReplay!(endpoint, nativeOptions(""), h.sessionId, false));
      } catch (err) {
        logger.warn("replay: native heldReplaySessions failed", err);
      }
    },
    isRecording(): boolean {
      if (!native || !active) return false;
      try {
        return native.isRecording() === true;
      } catch {
        return false;
      }
    },
    async flush(): Promise<void> {
      if (!native || !active) return;
      try {
        await native.flush();
      } catch (err) {
        logger.warn("replay: native flush failed", err);
      }
    },
    stop(): void {
      clearTimeout(showing);
      showing = undefined;
      pendingStart = undefined;
      if (!native || !active) return;
      active = false;
      call("stop", () => (native.stop ? native.stop() : native.pause()));
    },
    async decideHeld(current: string, crashedId: string | undefined): Promise<void> {
      if (!native || !endpoint || typeof native.heldReplaySessions !== "function" || typeof native.releaseHeldReplay !== "function") return;
      let held: NativeHeldSession[];
      try {
        held = await native.heldReplaySessions(endpoint, nativeOptions(current));
      } catch (err) {
        logger.warn("replay: native heldReplaySessions failed", err);
        return;
      }
      const [errors, feedback] = await Promise.all([tally.take(current), feedbackTally.take(current)]);
      for (const h of held) {
        if (h.sessionId === current) continue;
        const summary: HeldReplaySession = {
          sessionId: h.sessionId,
          chunks: h.chunks,
          bytes: h.bytes,
          firstChunkAt: h.firstAt,
          lastChunkAt: h.lastAt,
          crashed: h.sessionId === crashedId,
          errors: errors[h.sessionId] ?? 0,
          feedback: feedback[h.sessionId] ?? 0,
        };
        let keep = true;
        if (keepHook) {
          try {
            keep = (await keepHook(summary)) === true;
          } catch (err) {
            logger.warn("replay: keepAtNextLaunch threw; keeping the session", err);
          }
        }
        call("releaseHeldReplay", () => native.releaseHeldReplay!(endpoint, nativeOptions(current), h.sessionId, keep));
        logger.log(`replay: ${keep ? "sending" : "deleting"} the held replay of session ${h.sessionId}`, summary);
      }
    },
  };
}
