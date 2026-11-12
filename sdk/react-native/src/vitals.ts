/**
 * Mobile vitals (checklist G2), in the records of docs/specs/mobile-vitals.md:
 * - `ouo.stall`: JS event-loop stalls, measured here (50 ms loop, spec 2.4);
 * - `ouo.screen.display`: TTID per screen, from the navigation state change to the second
 *   animation frame after it (the frame that shows the new screen), measured here; and TTFD when
 *   the app calls `rum.reportFullyDisplayed()` on that screen (the frame after the call). The
 *   record waits for the report until the screen is left, the app goes to the background or
 *   `TTFD_TIMEOUT_MS` passed (Sentry's deadline), so it carries both values once;
 * - `ouo.app.start`: needs the native process start time (`getAppStartInfo`);
 * - `app.jank`: needs native frame counters (`getFrameStats`).
 * The last two come from the Expo module's iOS side (`OuoVitals` in sdk/ios); without them (Expo
 * Go, web, Android for now) the SDK emits nothing for that vital (spec rule 1: no record for a
 * value that was not measured).
 */
import type { DebugLogger } from "./logger";
import { guard } from "./guard";
import type { EventEmitter } from "./telemetry/events";
import type { Attrs, VitalsOptions } from "./types";

/** Optional native functions of the `OuoReplay` Expo module (iOS: `sdk/react-native/ios/OuoReplayModule.swift`). */
export interface NativeVitalsModule {
  /**
   * Start of this launch (epoch ms): the process start for `cold` (the app image load when iOS
   * prewarmed the process, `prewarmed: true`), the JS runtime's start for `warm` (a reload in a live process).
   */
  getAppStartInfo?(): { processStartMs?: number; type?: "cold" | "warm"; prewarmed?: boolean } | null | undefined;
  /** Cumulative frame counters since the module started (CADisplayLink / FrameMetrics). */
  getFrameStats?(): NativeFrameStats | null | undefined;
}

export interface NativeFrameStats {
  total: number;
  slow: number;
  frozen: number;
  /** Total time frames ran over their expected duration, ms. */
  delayMs?: number;
  /** Expected frame duration from the display refresh rate, ms (16.7 at 60 Hz). */
  expectedFrameMs?: number;
}

/** Stall loop (spec 2.4, Sentry React Native's stallTracking defaults). */
export const STALL_INTERVAL_MS = 50;
export const STALL_MIN_ITERATION_MS = 100;
/** How long a screen's display record waits for `reportFullyDisplayed` (Sentry's TTFD deadline). */
export const TTFD_TIMEOUT_MS = 30_000;
/** Spec rule 2: durations above one hour are clock jumps. */
const MAX_DURATION_MS = 60 * 60 * 1000;

export interface VitalsDeps {
  events: EventEmitter;
  logger: DebugLogger;
  native?: NativeVitalsModule | undefined;
  options?: VitalsOptions;
  /** App state when the SDK started: an app launched in the background (iOS prewarm) has no meaningful start. */
  launchedInForeground: boolean;
  now?: () => number;
  requestFrame?: (cb: () => void) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Vitals {
  /** The session exists: `ouo.app.start` may be emitted now. */
  sessionReady(): void;
  /** The root component mounted (RUMProvider): the first frame follows. */
  rootMounted(): void;
  /** A navigation to `screen` happened (state change). */
  navigated(screen: string): void;
  /** The app reports the current screen fully displayed (TTFD). */
  fullyDisplayed(): void;
  background(): void;
  foreground(): void;
  stop(): void;
}

interface VitalWindow {
  start: number;
  kind: "app_start" | "screen";
  screen?: string;
  frames?: NativeFrameStats;
  stalls: { count: number; total: number; longest: number };
}

const ms = (v: number): number => Math.round(v * 1000) / 1000;
const valid = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= MAX_DURATION_MS;

export function createVitals(deps: VitalsDeps): Vitals {
  const { events, logger } = deps;
  const now = deps.now ?? Date.now;
  // Every frame and timer callback runs inside the guard (ERR-1).
  const requestFrame = deps.requestFrame ?? ((cb: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => cb()) : setTimeout(cb, 16)));
  const raf = (cb: () => void): void => void requestFrame(guard.wrap("vitals.frame", cb));
  const startTimer = deps.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t));
  const setTimer = (fn: () => void, t: number): unknown => startTimer(guard.wrap("timer.vitals", fn), t);
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const enabled = deps.options?.enabled !== false;
  const native = deps.native;

  const nativeCall = <T>(name: string, fn: (() => T) | undefined): T | undefined => {
    if (!fn) return undefined;
    try {
      return fn();
    } catch (err) {
      logger.warn(`vitals: native ${name} failed`, err);
      return undefined;
    }
  };
  const frameStats = (): NativeFrameStats | undefined => {
    const s = nativeCall("getFrameStats", native?.getFrameStats ? () => native.getFrameStats!() : undefined);
    return s && typeof s.total === "number" ? s : undefined;
  };
  const startInfo = enabled ? nativeCall("getAppStartInfo", native?.getAppStartInfo ? () => native.getAppStartInfo!() : undefined) : undefined;
  const processStart = startInfo && typeof startInfo.processStartMs === "number" ? startInfo.processStartMs : undefined;

  const emit = (name: string, attrs: Attrs, at: number): void => events.emit(name, { ...attrs, "ouo.vital.source": "ouo" }, "info", at, { body: "" });

  // ---- app start ----
  let ready = false;
  let firstFrameAt: number | undefined;
  let appStartDone = !enabled || processStart === undefined || !deps.launchedInForeground;
  let firstScreen: string | undefined;
  const maybeAppStart = (): void => {
    if (appStartDone || !ready || firstFrameAt === undefined || processStart === undefined) return;
    appStartDone = true;
    const duration = firstFrameAt - processStart;
    if (!valid(duration)) return;
    const attrs: Attrs = { "ouo.app.start.type": startInfo?.type === "warm" ? "warm" : "cold", "ouo.app.start.duration_ms": ms(duration) };
    if (firstScreen) attrs["app.screen.name"] = firstScreen;
    emit("ouo.app.start", attrs, firstFrameAt);
  };
  const firstFrame = (at: number): void => {
    if (firstFrameAt !== undefined) return;
    firstFrameAt = at;
    maybeAppStart();
  };
  /** The frame that shows what was just rendered: the second animation frame from now. */
  const afterNextFrame = (cb: (at: number) => void): void => raf(() => raf(() => cb(now())));

  // ---- windows: app_start until the first screen, then one per screen visit ----
  const openWindow = (kind: VitalWindow["kind"], screen?: string): VitalWindow => {
    const w: VitalWindow = { start: now(), kind, stalls: { count: 0, total: 0, longest: 0 } };
    if (screen) w.screen = screen;
    const f = frameStats();
    if (f) w.frames = f;
    return w;
  };
  let win: VitalWindow | undefined = enabled ? openWindow("app_start") : undefined;
  const closeWindow = (): void => {
    const w = win;
    win = undefined;
    if (!w) return;
    const end = now();
    const period = end - w.start;
    if (!valid(period) || period === 0) return;
    const common: Attrs = { "ouo.vital.window": w.kind };
    if (w.screen) common["app.screen.name"] = w.screen;
    const f = w.frames ? frameStats() : undefined;
    if (w.frames && f) {
      const total = f.total - w.frames.total;
      const slow = f.slow - w.frames.slow;
      const frozen = f.frozen - w.frames.frozen;
      if (total > 0 && slow >= 0 && frozen >= 0) {
        const attrs: Attrs = {
          ...common,
          "app.jank.frame_count": slow + frozen,
          "app.jank.period": ms(period) / 1000,
          "ouo.frames.total": total,
          "ouo.frames.slow": slow,
          "ouo.frames.frozen": frozen,
        };
        if (f.expectedFrameMs) attrs["app.jank.threshold"] = f.expectedFrameMs / 1000;
        if (f.delayMs !== undefined && w.frames.delayMs !== undefined && f.delayMs >= w.frames.delayMs) attrs["ouo.frames.delay_ms"] = ms(f.delayMs - w.frames.delayMs);
        emit("app.jank", attrs, end);
      }
    }
    if (w.stalls.count > 0) {
      emit(
        "ouo.stall",
        { ...common, "ouo.stall.count": w.stalls.count, "ouo.stall.total_ms": ms(w.stalls.total), "ouo.stall.longest_ms": ms(w.stalls.longest), "ouo.stall.period_ms": ms(period) },
        end,
      );
    }
  };

  // ---- stalls ----
  const stallsOn = enabled && deps.options?.stalls !== false;
  let timer: unknown;
  let lastTick = 0;
  const tick = (): void => {
    const t = now();
    const iteration = t - lastTick;
    lastTick = t;
    if (iteration >= STALL_MIN_ITERATION_MS && iteration <= MAX_DURATION_MS && win) {
      const stall = iteration - STALL_INTERVAL_MS;
      win.stalls.count++;
      win.stalls.total += stall;
      win.stalls.longest = Math.max(win.stalls.longest, stall);
    }
    timer = setTimer(tick, STALL_INTERVAL_MS);
  };
  const startLoop = (): void => {
    if (!stallsOn || timer !== undefined) return;
    lastTick = now();
    timer = setTimer(tick, STALL_INTERVAL_MS);
  };
  const stopLoop = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  startLoop();

  let lastNavigation: string | undefined;

  // ---- the current screen's ouo.screen.display, held for TTFD ----
  interface Display {
    screen: string;
    /** Navigation start: the process start for the first screen, else the state change. */
    startAt: number | undefined;
    measured: boolean;
    ttidAt?: number;
    /** The frame after `reportFullyDisplayed`. */
    fullAt?: number;
    fullRequested?: boolean;
    timer?: unknown;
  }
  let display: Display | undefined;
  /** Emits the held record (TTID, and TTFD when reported) and forgets the screen. */
  const emitDisplay = (d: Display | undefined): void => {
    if (!d || d !== display) return;
    display = undefined;
    if (d.timer !== undefined) clearTimer(d.timer);
    if (!d.measured || d.startAt === undefined || d.ttidAt === undefined) return;
    const ttid = d.ttidAt - d.startAt;
    if (!valid(ttid)) return;
    const attrs: Attrs = { "app.screen.name": d.screen, "ouo.screen.ttid_ms": ms(ttid) };
    // Full display is never before the initial display (Sentry's rule).
    const ttfd = d.fullAt !== undefined ? Math.max(d.fullAt, d.ttidAt) - d.startAt : undefined;
    if (ttfd !== undefined && valid(ttfd)) attrs["ouo.screen.ttfd_ms"] = ms(ttfd);
    emit("ouo.screen.display", attrs, d.ttidAt);
  };

  return {
    sessionReady(): void {
      ready = true;
      maybeAppStart();
    },
    rootMounted(): void {
      if (!enabled || firstFrameAt !== undefined) return;
      afterNextFrame(firstFrame);
    },
    navigated(screen: string): void {
      if (!enabled || !screen || screen === lastNavigation) return;
      const isFirst = lastNavigation === undefined;
      lastNavigation = screen;
      const changedAt = now();
      if (isFirst) firstScreen = screen;
      emitDisplay(display);
      // First screen: from the process start (spec 5); later ones: from the state change.
      const d: Display = { screen, startAt: isFirst ? processStart : changedAt, measured: !isFirst || deps.launchedInForeground };
      display = d;
      afterNextFrame((at) => {
        firstFrame(at);
        if (display !== d) return;
        d.ttidAt = at;
        if (d.fullAt !== undefined) emitDisplay(d);
        else if (!d.fullRequested) d.timer = setTimer(() => emitDisplay(d), TTFD_TIMEOUT_MS);
      });
      closeWindow();
      win = openWindow("screen", screen);
    },
    fullyDisplayed(): void {
      const d = display;
      if (!d || d.fullRequested) {
        logger.log(
          d
            ? "vitals: reportFullyDisplayed already called for this screen"
            : lastNavigation === undefined
              ? "vitals: reportFullyDisplayed before the first screen, ignored"
              : `vitals: reportFullyDisplayed for ${lastNavigation} after its display record was sent (the ${TTFD_TIMEOUT_MS / 1000} s deadline or the background), ignored`,
        );
        return;
      }
      d.fullRequested = true;
      if (d.timer !== undefined) clearTimer(d.timer);
      afterNextFrame((at) => {
        d.fullAt = at;
        if (d.ttidAt !== undefined) emitDisplay(d);
      });
    },
    background(): void {
      emitDisplay(display);
      closeWindow();
      stopLoop();
    },
    foreground(): void {
      if (!enabled) return;
      if (!win) win = openWindow("screen", lastNavigation);
      startLoop();
    },
    stop(): void {
      emitDisplay(display);
      stopLoop();
      closeWindow();
    },
  };
}
