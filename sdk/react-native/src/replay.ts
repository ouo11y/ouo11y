import type { DebugLogger } from "./logger";
import type { ReplayOptions, RUMReplay } from "./types";
import { parseUrl } from "./url";

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
  stop?(): void;
}

/** Options the native `start` receives; mirrors `OuoReplayConfig` (docs/specs/mobile-replay.md). */
export interface NativeStartOptions {
  sessionId: string;
  frameInterval: number;
  maskText: boolean;
  maskInputs: boolean;
  maskImages: boolean;
  maskWebViews: boolean;
  debug: boolean;
}

export const NATIVE_MODULE_NAME = "OuoReplay";
export const DEFAULT_REPLAY_PORT = 8080;

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

/**
 * Default replay endpoint (rum-api): same scheme and host as the OTLP endpoint, port 8080.
 * The browser SDK takes `replayEndpoint` explicitly; mobile defaults it so the demo app's
 * `app.config.ts` does not need another setting.
 */
export function defaultReplayEndpoint(otlpEndpoint: string): string | undefined {
  const parsed = parseUrl(otlpEndpoint);
  if (!parsed) return undefined;
  return `${parsed.scheme}://${parsed.host}:${DEFAULT_REPLAY_PORT}`;
}

export interface ReplayControllerOptions {
  /** rum-api base URL; chunks go to `${endpoint}/v1/replay/chunks`. */
  endpoint: string | undefined;
  options: ReplayOptions | undefined;
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
  flush(): Promise<void>;
  stop(): void;
}

/**
 * Bridges `initRUM({ replay })` and the session manager to the native recorder. Replay is off
 * unless `replay.enabled === true` (ADR-0006: "Replay is off until the host enables it").
 */
export function createReplayController(opts: ReplayControllerOptions): ReplayController {
  const { logger } = opts;
  const enabled = opts.options?.enabled === true;
  const native = enabled ? (opts.native === undefined ? loadNativeReplayModule() : opts.native ?? undefined) : undefined;
  const endpoint = opts.endpoint;
  let active = false;
  let currentId: string | undefined;

  if (enabled && !native) {
    // One line, debug only: Expo Go, web and Jest/Vitest all land here.
    logger.warn(`replay: native module OuoReplay unavailable (Expo Go, web or a build without the dev client); replay disabled. ${lastNativeLoadError ?? ""}`);
  }
  if (enabled && native && !endpoint) {
    logger.warn("replay: no replayEndpoint and the OTLP endpoint could not be parsed; replay disabled");
  }

  const call = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn(`replay: native ${what} failed`, err);
    }
  };

  return {
    get active() {
      return active;
    },
    start(sessionId: string): void {
      if (!native || !endpoint || active) return;
      currentId = sessionId;
      const startOptions: NativeStartOptions = {
        sessionId,
        frameInterval: opts.options?.frameInterval ?? 1,
        maskText: opts.options?.maskText !== false,
        maskInputs: opts.options?.maskInputs !== false,
        maskImages: opts.options?.maskImages !== false,
        maskWebViews: opts.options?.maskWebViews !== false,
        debug: logger.enabled,
      };
      call("start", () => {
        native.setSessionId(sessionId);
        native.start(endpoint, startOptions);
        active = true;
        logger.log("replay: started", { endpoint, ...startOptions });
      });
    },
    sessionDidRotate(id: string): void {
      if (!native || !active) return;
      // The manager also reports the initial session (cold start resolution): same id, nothing to do.
      if (id === currentId) return;
      currentId = id;
      call("sessionDidRotate", () => native.sessionDidRotate(id));
      logger.log("replay: session rotated", id);
    },
    pause(): void {
      if (!native || !active) return;
      call("pause", () => native.pause());
    },
    resume(): void {
      if (!native || !active) return;
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
