import { guard } from "./guard";
import type { DebugLogger } from "./logger";
import { SAMPLING_SALT, sampled, sampleRate } from "./sampling";
import type { AttrValue, ReplayCadence, ReplayMode, ReplayOptions } from "./types";

/**
 * Session replay (ADR-0021 decision 5): the native module captures, masks, queues on disk and
 * sends. A chunk is one OTLP/HTTP protobuf request to `${endpoint}/v1/logs` holding one
 * `ouo.replay.chunk` log record (scope `ouo.replay`); the stream ends with `ouo.replay.ended`.
 * This file is the JS side: which sessions record and how (whole session, or a buffer sent on
 * the first error), consent, never-record screens, and the calls into the native module, every
 * one of them inside the guard.
 */

/** Trace of what `ouo.replay.trigger` may say when a buffered replay is sent. */
export type ReplayTrigger = "error" | "crash" | "hang" | "manual";

/** How the previous run ended, as far as the SDK knows: the native side ends that run's open stream with it. */
export type PreviousExit = "crash" | "background_kill";

/** `start(endpoint, options)` of the native module on the OTLP path (the `otlp` key selects it). */
export interface NativeStartOptions {
  sessionId: string;
  projectId: string;
  projectToken: string;
  /** What is recorded (`replay.mode`). */
  mode: ReplayMode;
  /** When a frame is taken (`replay.cadence`). */
  cadence: ReplayCadence;
  frameInterval: number;
  maskText: boolean;
  maskInputs: boolean;
  maskImages: boolean;
  maskWebViews: boolean;
  debug: boolean;
  otlp: {
    logsUrl: string;
    resource?: Record<string, AttrValue>;
    schemaUrl?: string;
    scopeVersion?: string;
    previousExit?: PreviousExit;
  };
  /** Present: keep a ring of that many seconds and send it on `capture(trigger)`. Absent: record the whole session. */
  buffer?: { seconds: number };
}

/**
 * Native module contract (iOS: `OuoReplayModule.swift` over `sdk/ios`; Android:
 * `OuoReplayModule.kt` over `sdk/android`; the same on both). Only `start` is required: a module
 * without one of the others is an older build, and the call is skipped.
 */
export interface NativeReplayModule {
  start(endpoint: string, options: NativeStartOptions): void;
  pause?(): void;
  resume?(): void;
  isRecording?(): boolean;
  /** Resolves once the open chunk was cut and handed to the native queue. */
  flush?(): Promise<void>;
  /** Ends the stream with `ouo.replay.ended` (reason `session_end`) and starts a new replay for the new session. */
  sessionDidRotate?(id: string): void;
  setSessionId?(id: string): void;
  /** A route change: the frame for the new screen with the `navigation` cadence. */
  screenDidChange?(): void;
  /** Stops; the stream ends with reason `stop`. */
  stop?(): void;
  /** Stops; the stream ends with reason `session_end`. */
  endSession?(): void;
  /** Buffer mode: sends the ring and records on as a session. */
  capture?(trigger: string): void;
  /** The screen the next chunks belong to (`ouo.view.id`). */
  setViewId?(id: string): void;
  mask?(reactTag: number): void;
  unmask?(reactTag: number): void;
  /** Stops without an end record and deletes every replay record not yet accepted (consent withdrawn). */
  discardPending?(): Promise<void>;
  /** What replay dropped or could not do in this process, by reason. */
  replayDiagnostics?(): Record<string, number>;
}

export const NATIVE_MODULE_NAME = "OuoReplay";

/** How long capture stays paused after the last hidden screen was left (docs/specs/mobile-replay.md, "Never-record screens"). */
export const SHOW_DELAY_MS = 500;

/** The schema the replay records are written against. */
export const REPLAY_SCHEMA_URL = "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev";

export const DEFAULT_REPLAY_MODE: ReplayMode = "pixel/frames";
export const DEFAULT_BUFFER_SECONDS = 60;

/** Every value `replay.mode` may have on mobile (`structure/dom` is web only). No shorthand. */
export const REPLAY_MODES: readonly ReplayMode[] = ["pixel/frames", "pixel/video", "structure/wireframe"];
/**
 * The modes the native module of this package can record. The one place to add a
 * mode when its recorder ships. Android before 8 (API 26) has no `pixel/video`: native leaves replay off there.
 */
export const NATIVE_REPLAY_MODES: ReadonlySet<ReplayMode> = new Set<ReplayMode>(["pixel/frames", "pixel/video"]);
const CADENCES: readonly ReplayCadence[] = ["auto", "session", "navigation"];

export interface ResolvedReplayMode {
  /** Undefined: replay stays off. */
  mode: ReplayMode | undefined;
  cadence: ReplayCadence;
  /** At most one, for the debug log: why replay is off, or what is deprecated. */
  warning?: string;
}

/**
 * `replay.mode` and `replay.cadence` as the SDK uses them. Never throws. A value that is not a
 * mode, or a mode this build cannot record, leaves replay off with one warning. A cadence given
 * as `mode` (`auto`, `session`, `navigation`: what `replay.mode` meant before 0.4) is read as
 * `replay.cadence`, with a deprecation warning.
 */
export function resolveReplayMode(options: ReplayOptions | undefined, supported: ReadonlySet<ReplayMode> = NATIVE_REPLAY_MODES): ResolvedReplayMode {
  const given: unknown = options?.mode;
  const cadenceGiven: unknown = options?.cadence;
  let cadence: ReplayCadence = CADENCES.includes(cadenceGiven as ReplayCadence) ? (cadenceGiven as ReplayCadence) : "auto";
  if (given === undefined || given === null) return { mode: DEFAULT_REPLAY_MODE, cadence };
  if (CADENCES.includes(given as ReplayCadence)) {
    if (cadenceGiven === undefined) cadence = given as ReplayCadence;
    return { mode: DEFAULT_REPLAY_MODE, cadence, warning: `replay.mode: "${String(given)}" is deprecated: it is now replay.cadence; replay.mode is what is recorded (default "${DEFAULT_REPLAY_MODE}")` };
  }
  if (!REPLAY_MODES.includes(given as ReplayMode)) {
    const shown = typeof given === "string" ? `"${given.slice(0, 40)}"` : typeof given;
    return { mode: undefined, cadence, warning: `replay.mode ${shown} is not a replay mode (${REPLAY_MODES.join(", ")}; no shorthand): replay is off` };
  }
  if (!supported.has(given as ReplayMode)) {
    return { mode: undefined, cadence, warning: `replay.mode "${String(given)}" is not available in this build (available: ${Array.from(supported).join(", ")}): replay is off` };
  }
  return { mode: given as ReplayMode, cadence };
}

/** Why the native module could not be loaded, for the debug log (set by the last load attempt). */
export let lastNativeLoadError: string | undefined;

/**
 * Loads the native Expo module, or returns undefined when it cannot exist (Expo Go, web, tests
 * without the stand-in). Never throws.
 */
export function loadNativeReplayModule(): NativeReplayModule | undefined {
  lastNativeLoadError = undefined;
  try {
    // 1. The JSI host object installed by expo-modules-core at runtime start. Reading it
    //    needs no JS dependency, so it also works when Metro did not bundle the package.
    const registry = (globalThis as { expo?: { modules?: Record<string, NativeReplayModule> } }).expo?.modules;
    let mod: NativeReplayModule | undefined = registry?.[NATIVE_MODULE_NAME];
    if (!mod) {
      // 2. The documented API. Literal require so Metro bundles it when it is installed.
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

// Indirection so tests can simulate the package being absent.
let expoModulesCore: () => ExpoModulesCoreLike | undefined = () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("expo-modules-core") as ExpoModulesCoreLike | undefined;

/** Test hook. */
export function _setExpoModulesCore(resolver: (() => ExpoModulesCoreLike | undefined) | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expoModulesCore = resolver ?? (() => require("expo-modules-core") as ExpoModulesCoreLike | undefined);
}

/** `findNodeHandle` of react-native, injectable for tests: a ref (or a component instance) to its native tag. */
export type FindNodeHandle = (ref: unknown) => number | null | undefined;

/**
 * The native tag of what `replay.mask(target)` was given: a tag (a positive whole number), a
 * ref object (`{ current }`) or a component instance, through `findNodeHandle`. Undefined when
 * it is none of them or the view is not mounted.
 */
export function nativeTag(target: unknown, find: FindNodeHandle | undefined): number | undefined {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 2_147_483_647;
  if (valid(target)) return target;
  if (!target || typeof target !== "object" || !find) return undefined;
  const instance = "current" in (target as object) ? (target as { current: unknown }).current : target;
  if (valid(instance)) return instance;
  if (!instance) return undefined;
  try {
    const tag = find(instance);
    return valid(tag) ? tag : undefined;
  } catch {
    // not a component instance
    return undefined;
  }
}

/** A fresh `ouo.view.id`: 32 lowercase hex characters. */
export function newViewId(): string {
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export interface ReplayControllerOptions {
  /** Collector OTLP/HTTP base URL; chunks go to `logsUrl`. */
  endpoint: string | undefined;
  /** Where chunks go; default `${endpoint}/v1/logs`. */
  logsUrl?: string | undefined;
  /** Sent with every chunk request as `Authorization: Basic base64(projectId:projectToken)` (ADR-0007). */
  projectId: string;
  projectToken: string;
  options: ReplayOptions | undefined;
  /** `session.sampleRate`: replay never records a session that is outside the session sample. */
  sessionSampleRate?: number;
  /** The session's persisted sampling decision (spec SMP-1); the hash of the id when it gives none. */
  sessionDecision?: (sessionId: string) => boolean | undefined;
  /** The resource attributes telemetry carries (primitives): the replay records carry the same. */
  resource?: Record<string, AttrValue>;
  scopeVersion?: string;
  previousExit?: PreviousExit;
  /** Override for tests; default `loadNativeReplayModule()`. */
  native?: NativeReplayModule | null;
  findNodeHandle?: FindNodeHandle;
  /** A stretch of the session is not recorded: `ouo.replay.hidden` on the timeline (spec section 5c, rule 3). */
  onHidden?: (reason: "screen" | "manual") => void;
  /** Replay consent (spec PRV-3). False: the native recorder is not started and sends nothing until `setAllowed(true)`. Default true. */
  allowed?: boolean;
  logger: DebugLogger;
}

/** `excludeScreens`: a string matches the name or the path exactly, or as a prefix with a trailing `*`; a RegExp is tested against both. */
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

/** How a session is recorded: from its start, as a buffer sent on the first error, or not at all. */
type Plan = "session" | "buffer" | undefined;

export interface ReplayController {
  /** True once native capture was started. */
  readonly active: boolean;
  /** The mode in use; undefined when replay is off (not enabled, no native module, an unusable `replay.mode`). */
  readonly mode: ReplayMode | undefined;
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  hideScreen(): void;
  showScreen(): void;
  start(sessionId: string): void;
  sessionDidRotate(id: string): void;
  /** A route change: a new `ouo.view.id` for the chunks that follow, and the frame for the new screen. */
  screenDidChange(): void;
  /** The screen the app shows now (its navigation path): pauses native capture on a never-record screen. */
  setScreen(path: string): void;
  /** A buffered replay is sent: on the first bypass-set record (`error`, `crash`, `hang`) or on `replay.capture()` (`manual`). */
  capture(trigger: ReplayTrigger): void;
  mask(target: unknown): void;
  unmask(target: unknown): void;
  flush(): Promise<void>;
  /** Stops recording; the stream ends with reason `stop`. */
  stop(): void;
  /** `shutdown()`: stops recording; the stream ends with reason `session_end`. */
  end(): void;
  /** Replay consent changed: false stops the recorder and deletes what was not sent, true starts it for the current session. */
  setAllowed(allowed: boolean): void;
}

export function createReplayController(opts: ReplayControllerOptions): ReplayController {
  const { logger } = opts;
  const enabled = opts.options?.enabled === true;
  const loaded = enabled ? (opts.native === undefined ? loadNativeReplayModule() : opts.native ?? undefined) : undefined;
  const resolved = enabled ? resolveReplayMode(opts.options) : { mode: undefined, cadence: "auto" as ReplayCadence };
  // The one warning: an unusable mode, or the old meaning of `replay.mode`.
  if (resolved.warning) logger.warn(`replay: ${resolved.warning}`);
  if (enabled && !loaded) {
    logger.warn(`replay: native module OuoReplay unavailable (Expo Go, web or a build without the dev client); replay disabled. ${lastNativeLoadError ?? ""}`);
  }
  const endpoint = opts.endpoint;
  const logsUrl = opts.logsUrl ?? (endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/logs` : undefined);
  if (enabled && loaded && !(endpoint && logsUrl)) logger.warn("replay: no endpoint; replay disabled");
  // Everything below runs only with a module, a usable mode and somewhere to send.
  const mode = resolved.mode;
  const native = mode && endpoint && logsUrl ? loaded : undefined;

  const sessionRate = sampleRate(opts.sessionSampleRate, 1);
  const replayRate = sampleRate(opts.options?.sampleRate, 1);
  const onErrorRate = sampleRate(opts.options?.onErrorSampleRate, 0);
  const seconds = opts.options?.bufferSeconds;
  const bufferSeconds = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_BUFFER_SECONDS;

  let active = false;
  /** How the native recorder was started for the active session. */
  let activePlan: Plan;
  /** The active buffer was sent already: one trigger per session. */
  let captured = false;
  let currentId: string | undefined;
  let userPaused = false;
  let allowed = opts.allowed !== false;
  let screenHidden = false;
  let manualHidden = false;
  let showing: ReturnType<typeof setTimeout> | undefined;
  /** The session that starts recording once the screen is shown or consent is given. */
  let pendingStart: string | undefined;
  const hidden = (): boolean => screenHidden || manualHidden || showing !== undefined;
  const excludeScreens = opts.options?.excludeScreens;

  /** A native call: skipped when this build has no such method, never throws, a rejection is swallowed. */
  const call = <K extends keyof NativeReplayModule>(method: K, ...args: Parameters<NonNullable<NativeReplayModule[K]>>): unknown => {
    const fn = native?.[method] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== "function") return undefined;
    try {
      const out = fn.apply(native, args);
      if (out && typeof (out as Promise<unknown>).then === "function") return (out as Promise<unknown>).then(undefined, (err: unknown) => logger.warn(`replay: native ${method} failed`, err));
      return out;
    } catch (err) {
      logger.warn(`replay: native ${method} failed`, err);
      return undefined;
    }
  };

  // RPL-19: only in a session that is in the session sample, then by the replay rates.
  const inSessionSample = (id: string): boolean => opts.sessionDecision?.(id) ?? sampled(id, sessionRate, SAMPLING_SALT.session);
  const planFor = (id: string): Plan => {
    if (!inSessionSample(id)) return undefined;
    if (sampled(id, replayRate, SAMPLING_SALT.replay)) return "session";
    return sampled(id, onErrorRate, SAMPLING_SALT.replayOnError) ? "buffer" : undefined;
  };

  const nativeOptions = (sessionId: string, plan: Plan): NativeStartOptions => ({
    sessionId,
    projectId: opts.projectId,
    projectToken: opts.projectToken,
    mode: mode!,
    cadence: resolved.cadence,
    frameInterval: opts.options?.frameInterval ?? 1,
    maskText: opts.options?.maskText !== false,
    maskInputs: opts.options?.maskInputs !== false,
    maskImages: opts.options?.maskImages !== false,
    maskWebViews: opts.options?.maskWebViews !== false,
    debug: logger.enabled,
    otlp: {
      logsUrl: logsUrl!,
      ...(opts.resource ? { resource: opts.resource } : {}),
      schemaUrl: REPLAY_SCHEMA_URL,
      ...(opts.scopeVersion ? { scopeVersion: opts.scopeVersion } : {}),
      ...(opts.previousExit ? { previousExit: opts.previousExit } : {}),
    },
    ...(plan === "buffer" ? { buffer: { seconds: bufferSeconds } } : {}),
  });

  const hiddenReason = (): "screen" | "manual" => (screenHidden ? "screen" : "manual");

  const startNative = (sessionId: string): void => {
    if (!native || active) return;
    const plan = planFor(sessionId);
    if (!plan) {
      logger.log("replay: session not in the replay sample", sessionId);
      return;
    }
    if (!allowed) {
      // Remembered: `setAllowed(true)` starts it.
      pendingStart = sessionId;
      return;
    }
    // Native start takes a frame at once: on a hidden screen, start once it is shown.
    if (hidden()) {
      // One mark per stretch and session; none while the host paused (the manual-pause semantics apply).
      if (pendingStart !== sessionId && !userPaused) opts.onHidden?.(hiddenReason());
      pendingStart = sessionId;
      return;
    }
    pendingStart = undefined;
    const startOptions = nativeOptions(sessionId, plan);
    try {
      native.setSessionId?.(sessionId);
      native.start(endpoint!, startOptions);
      active = true;
      activePlan = plan;
      captured = false;
      // Never the project token, not even a prefix (spec CFG-3).
      const { projectToken: _token, ...shown } = startOptions;
      logger.log(`replay: started (${plan === "buffer" ? `buffer of ${bufferSeconds} s, sent on the first error` : "whole session"})`, { endpoint, ...shown, otlp: { logsUrl } });
    } catch (err) {
      logger.warn("replay: native start failed", err);
    }
    if (active && userPaused) call("pause");
  };

  const stopNative = (how: "stop" | "endSession"): void => {
    if (!native || !active) return;
    active = false;
    activePlan = undefined;
    // An older build without `endSession` still stops.
    if (how === "endSession" && typeof native.endSession === "function") call("endSession");
    else if (typeof native.stop === "function") call("stop");
    else call("pause");
  };

  const show = (): void => {
    if (hidden() || !native) return;
    if (!active) {
      if (pendingStart !== undefined) startNative(pendingStart);
      return;
    }
    if (userPaused) return;
    call("resume");
    logger.log("replay: shown");
  };

  // Capture is held while a never-record screen or `hideScreen()` asks for it, and for
  // SHOW_DELAY_MS after the last one stopped: one stretch, one `ouo.replay.hidden` mark.
  const setHidden = (screen: boolean, manual: boolean, reason: "screen" | "manual"): void => {
    const was = screenHidden || manualHidden;
    screenHidden = screen;
    manualHidden = manual;
    const now = screenHidden || manualHidden;
    if (was === now) return;
    if (!now) {
      // The transition out of the hidden screen can still show it: wait before the next frame.
      showing = setTimeout(
        guard.wrap("timer.replay", () => {
          showing = undefined;
          show();
        }),
        SHOW_DELAY_MS,
      );
      return;
    }
    if (showing !== undefined) {
      // Hidden again within the delay: capture never resumed, the stretch goes on.
      clearTimeout(showing);
      showing = undefined;
      return;
    }
    if (!native || !active || userPaused) return;
    call("pause");
    logger.log(`replay: hidden (${reason})`);
    opts.onHidden?.(reason);
  };

  return {
    get active() {
      return active;
    },
    get mode() {
      return native ? mode : undefined;
    },
    start(sessionId: string): void {
      if (!native || active) return;
      currentId = sessionId;
      startNative(sessionId);
    },
    sessionDidRotate(id: string): void {
      if (!native || id === currentId) return;
      currentId = id;
      const plan = planFor(id);
      if (!active) {
        pendingStart = undefined;
        startNative(id);
        return;
      }
      if (plan === "session" && activePlan === "session") {
        // Whole session to whole session: the native side ends the stream (`session_end`) and starts
        // the next replay with the options it has.
        call("sessionDidRotate", id);
        logger.log("replay: session rotated", id);
        if (hidden() && !userPaused) opts.onHidden?.(hiddenReason());
        return;
      }
      // The new session is recorded differently, or the recorder runs with buffer options (a
      // buffer is per session, sent or not): end this one, start as planned.
      stopNative("endSession");
      startNative(id);
    },
    screenDidChange(): void {
      if (!native || !active) return;
      // No view id in the SDK's records yet (`ouo.view.id` is a later step): one is made here, for replay only.
      call("setViewId", newViewId());
      if (!hidden()) call("screenDidChange");
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
    capture(trigger: ReplayTrigger): void {
      // Only a buffer has something to send; a whole-session recording is already on its way.
      if (!native || !active || activePlan !== "buffer" || captured) return;
      captured = true;
      call("capture", trigger);
      logger.log("replay: buffer sent, recording on", trigger);
    },
    mask(target: unknown): void {
      const tag = nativeTag(target, opts.findNodeHandle);
      if (native && tag !== undefined) call("mask", tag);
    },
    unmask(target: unknown): void {
      const tag = nativeTag(target, opts.findNodeHandle);
      if (native && tag !== undefined) call("unmask", tag);
    },
    pause(): void {
      userPaused = true;
      if (!native || !active || hidden()) return;
      call("pause");
    },
    resume(): void {
      userPaused = false;
      if (!native || !active || hidden()) return;
      call("resume");
    },
    isRecording(): boolean {
      return !!native && active && call("isRecording") === true;
    },
    async flush(): Promise<void> {
      if (!native) return;
      await call("flush");
    },
    stop(): void {
      clearTimeout(showing);
      showing = undefined;
      pendingStart = undefined;
      stopNative("stop");
    },
    end(): void {
      clearTimeout(showing);
      showing = undefined;
      pendingStart = undefined;
      stopNative("endSession");
    },
    setAllowed(next: boolean): void {
      if (next === allowed) return;
      allowed = next;
      if (!next) {
        // Consent withdrawn (PRV-4): stop, then delete every replay record not yet accepted.
        if (active) pendingStart = currentId;
        stopNative("stop");
        void call("discardPending");
        return;
      }
      const id = pendingStart ?? currentId;
      if (id !== undefined) startNative(id);
    },
  };
}
