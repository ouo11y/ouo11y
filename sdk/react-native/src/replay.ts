import type { DebugLogger } from "./logger";
import { SAMPLING_SALT, sampled, sampleRate } from "./sampling";
import type { ReplayMode, ReplayOptions, RUMReplay } from "./types";

/**
 * Shape of the Expo native module `OuoReplay` (sdk/react-native/ios/OuoReplayModule.swift,
 * Android stub in android/). Every function is synchronous except `flush`.
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
}

export const NATIVE_MODULE_NAME = "OuoReplay";

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
  logger: DebugLogger;
}

/** What `initRUM` drives; `RUMReplay` is the public subset exposed as `rum.replay`. */
export interface ReplayController extends RUMReplay {
  /** True when the native recorder was started. */
  readonly active: boolean;
  start(sessionId: string): void;
  sessionDidRotate(id: string): void;
  /** A new screen is showing: the frame for it in `navigation` mode. */
  screenDidChange(): void;
  /** An error in the current session: starts an error-triggered recording when sampled. */
  onError(): void;
  flush(): Promise<void>;
  stop(): void;
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
  /** Paused because the current session is not recorded. */
  let samplePaused = false;
  /** The current session started recording at an error. */
  let errorTriggered = false;

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

  const nativeOptions = (sessionId: string): NativeStartOptions => ({
    sessionId,
    projectId: opts.projectId,
    projectToken: opts.projectToken,
    mode: opts.options?.mode ?? "auto",
    frameInterval: opts.options?.frameInterval ?? 1,
    maskText: opts.options?.maskText !== false,
    maskInputs: opts.options?.maskInputs !== false,
    maskImages: opts.options?.maskImages !== false,
    maskWebViews: opts.options?.maskWebViews !== false,
    debug: logger.enabled,
  });

  // The chunk a crash left open goes out whatever this launch's sampling decides.
  if (native && endpoint && typeof native.recoverPendingChunk === "function") {
    call("recoverPendingChunk", () => native.recoverPendingChunk!(endpoint, nativeOptions("")));
  }

  const startNative = (sessionId: string): void => {
    if (!native || !endpoint || active) return;
    const startOptions = nativeOptions(sessionId);
    call("start", () => {
      native.setSessionId(sessionId);
      native.start(endpoint, startOptions);
      active = true;
      logger.log("replay: started", { endpoint, ...startOptions, projectToken: `${opts.projectToken.slice(0, 8)}…` });
    });
    if (active && userPaused) call("pause", () => native.pause());
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
        if (recorded(id)) startNative(id);
        return;
      }
      call("sessionDidRotate", () => native.sessionDidRotate(id));
      logger.log("replay: session rotated", id);
      if (!recorded(id)) {
        if (!samplePaused && !userPaused) call("pause", () => native.pause());
        samplePaused = true;
        logger.log("replay: session not in the replay sample", id);
      } else if (samplePaused) {
        samplePaused = false;
        if (!userPaused) call("resume", () => native.resume());
      }
    },
    screenDidChange(): void {
      if (!native || !active || !native.screenDidChange) return;
      call("screenDidChange", () => native.screenDidChange!());
    },
    onError(): void {
      const id = currentId;
      if (!native || !endpoint || id === undefined || errorTriggered) return;
      if (!inSessionSample(id) || recorded(id) || !sampled(id, onErrorRate, SAMPLING_SALT.replayOnError)) return;
      errorTriggered = true;
      logger.log("replay: recording triggered by an error", id);
      if (!active) {
        startNative(id);
      } else if (samplePaused) {
        samplePaused = false;
        if (!userPaused) call("resume", () => native.resume());
      }
    },
    pause(): void {
      userPaused = true;
      if (!native || !active || samplePaused) return;
      call("pause", () => native.pause());
    },
    resume(): void {
      userPaused = false;
      if (!native || !active || samplePaused) return;
      call("resume", () => native.resume());
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
      if (!native || !active) return;
      active = false;
      call("stop", () => (native.stop ? native.stop() : native.pause()));
    },
  };
}
