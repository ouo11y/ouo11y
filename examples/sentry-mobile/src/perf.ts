// Overhead measurement build only (OUO_PERF=1, scripts/perf/run.sh). Imported first in index.ts.
//
// JS thread frame monitor, the same idea as React Native's perf monitor: a requestAnimationFrame
// loop on the JS thread; an interval longer than one display frame means the JS thread missed
// frames. The interval histogram (1 ms buckets) and the first-frame time go to
// Documents/perf.json every 2 s; the harness reads the last copy after the run and computes
// dropped frames against the measured refresh interval. Wall-clock (Date.now) times so the host
// can compare them with the process start time from the kernel. A no-op in other builds.
//
// Benchmark tiers (docs/benchmarks.md section 1): Documents/perf-mode.json may carry
// "tier": "T1" | "T2" | "T3" | "T4". The tier only reshapes the options src/sentry.ts and src/ouo.ts
// already pass (perfSentryOptions, perfOuoReplay); without a tier, or outside OUO_PERF=1 builds,
// both return the app's own options unchanged.
import * as Sentry from "@sentry/react-native";
import { File, Paths } from "expo-file-system";
import { config } from "./config";
import { usesOuo, usesSentry, type Launch } from "./rollout";

const TIERS = ["T1", "T2", "T3", "T4"] as const;
type Tier = (typeof TIERS)[number];

function readTier(): Tier | undefined {
  if (!config.perfModes) return undefined;
  try {
    const f = new File(Paths.document, "perf-mode.json");
    const t = f.exists ? (JSON.parse(f.textSync()) as { tier?: unknown }).tier : undefined;
    return (TIERS as readonly unknown[]).includes(t) ? (t as Tier) : undefined;
  } catch {
    return undefined;
  }
}

/** This launch's benchmark tier, read once at JS start (before either SDK initialises). */
export const perfTier = readTier();

type SentryOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * Sentry per tier, from the app's own options: T1 errors, crashes and sessions only (tracing,
 * logs and replay off, so Sentry's defaults); T2 + tracing and logs; T3 + replay with the
 * integration's defaults (everything masked); T4 + replay at matched quality (medium = 1 px per
 * point, 1 frame/s, masking off, as ouo's T4). Sampling stays 100 %.
 */
export function perfSentryOptions(o: SentryOptions): SentryOptions {
  if (!perfTier) return o;
  const tracing = perfTier !== "T1";
  const replay = perfTier === "T3" || perfTier === "T4";
  const tracingIntegrations = ["ReactNavigation", "ReactNativeTracing"];
  const integrations = (Array.isArray(o.integrations) ? o.integrations : []).filter(
    (i) => i.name !== "MobileReplay" && (tracing || !tracingIntegrations.includes(i.name)),
  );
  if (perfTier === "T3") integrations.push(Sentry.mobileReplayIntegration());
  if (perfTier === "T4") integrations.push(Sentry.mobileReplayIntegration({ maskAllText: false, maskAllImages: false, maskAllVectors: false }));
  const out: SentryOptions = { ...o, integrations, enableAutoPerformanceTracing: tracing };
  if (!tracing) {
    delete out.tracesSampleRate;
    delete out.enableLogs;
  }
  if (!replay) {
    delete out.replaysSessionSampleRate;
    delete out.replaysOnErrorSampleRate;
  }
  if (perfTier === "T4") out.replaysSessionQuality = "medium";
  return out;
}

/**
 * ouo replay per tier, or undefined (no tier: the app's own setting). ouo has no errors-only
 * setup (its fetch tracing is always on), so T1 runs as T2. T3: the SDK's defaults (masking on).
 * T4: 1 frame/s (the default), masking off, as Sentry's T4.
 */
export function perfOuoReplay(): { enabled: boolean; frameInterval?: number; maskText?: boolean; maskInputs?: boolean; maskImages?: boolean; maskWebViews?: boolean } | undefined {
  if (!perfTier) return undefined;
  if (perfTier === "T1" || perfTier === "T2") return { enabled: false };
  if (perfTier === "T3") return { enabled: true };
  return { enabled: true, frameInterval: 1, maskText: false, maskInputs: false, maskImages: false, maskWebViews: false };
}

const jsStartMs = Date.now();
let firstFrameMs: number | null = null;
let frames = 0;
let last = 0;
let maxDt = 0;
let launchMode: { mode: string; sentry: boolean; ouo: boolean; ouoReplay: boolean; tier: string | null } | null = null;

/** The SDK mix this launch runs (index.ts), recorded in perf.json. */
export function setPerfLaunch(l: Launch): void {
  const ouoReplay = usesOuo(l.mode) && (perfOuoReplay()?.enabled ?? l.ouoReplay);
  launchMode = { mode: l.mode, sentry: usesSentry(l.mode), ouo: usesOuo(l.mode), ouoReplay, tier: perfTier ?? null };
}
const hist: Record<number, number> = {};

function tick(now: number): void {
  if (last > 0) {
    const dt = now - last;
    const bucket = Math.min(2000, Math.round(dt));
    hist[bucket] = (hist[bucket] ?? 0) + 1;
    frames++;
    if (dt > maxDt) maxDt = dt;
  }
  last = now;
  requestAnimationFrame(tick);
}

function write(): void {
  try {
    const f = new File(Paths.document, "perf.json");
    if (!f.exists) f.create();
    f.write(
      JSON.stringify({
        mode: launchMode,
        jsStartMs,
        firstFrameMs,
        writtenMs: Date.now(),
        frames,
        maxDt,
        hist,
      }),
    );
  } catch {
    // best effort
  }
}

/** Called once from App after the navigation container is ready: the first screen is on screen. */
export function markFirstFrame(): void {
  if (!config.perfModes || firstFrameMs !== null) return;
  requestAnimationFrame(() => {
    firstFrameMs = Date.now();
    write();
  });
}

if (config.perfModes) {
  requestAnimationFrame(tick);
  setInterval(write, 2000);
}
