// Runtime switch between Sentry and ouo, driven by the OpenFeature flag `ouo.rum.mode`
// (ROLLOUT.md). Runs before any monitoring SDK initialises.
//
//   sentry    Sentry only, DSN = the ouo Sentry bridge (Sentry still gets every envelope).
//   parallel  Sentry (DSN = Sentry directly, never the bridge, or ouo would see each session
//             twice) + ouo with ouo replay off.
//   ouo       ouo only, ouo replay on. Sentry is never initialised.
//
// The mode is fixed for the whole process. Both SDKs install process-wide hooks (ErrorUtils
// handler chain, Hermes' single promise rejection tracker, fetch / XHR wrappers, native crash
// and replay recorders) that cannot be removed again, so a new flag value takes effect at the
// next cold start, never mid-session. Each launch:
//   1. reads the decision stored by the previous launch (sync file read: no await before init);
//   2. applies it, or on the very first launch waits up to `flagTimeoutMs` for the flag;
//   3. evaluates the flag again in the background and stores the result for the next launch.
// The device bucket is a random id kept in the same file and used as the OpenFeature
// `targetingKey`, so a percentage rollout puts a device in the same cohort on every launch.
import { OFREPWebProvider } from "@openfeature/ofrep-web-provider";
import { InMemoryProvider, OpenFeature, type Provider } from "@openfeature/web-sdk";
import { File, Paths } from "expo-file-system";
import { config } from "./config";

export const FLAG_KEY = "ouo.rum.mode";
export const RUM_MODES = ["sentry", "parallel", "ouo"] as const;
export type RumMode = (typeof RUM_MODES)[number];

/** Where this launch's mode came from. */
export type ModeSource = "stored" | "flag" | "default";

export interface Launch {
  mode: RumMode;
  source: ModeSource;
  deviceId: string;
  /** The flag's answer for the next launch, once the background evaluation finished. */
  next: Promise<RumMode | undefined>;
}

interface Stored {
  deviceId: string;
  /** Applied at the next cold start. */
  nextMode?: RumMode;
  evaluatedAt?: string;
  variant?: string;
  reason?: string;
}

const isMode = (v: unknown): v is RumMode => typeof v === "string" && (RUM_MODES as readonly string[]).includes(v);

const stateFile = (): File => new File(Paths.document, "ouo-rum-mode.json");

function readStored(): Stored | undefined {
  try {
    const f = stateFile();
    if (!f.exists) return undefined;
    const s = JSON.parse(f.textSync()) as Partial<Stored>;
    return typeof s.deviceId === "string" && s.deviceId ? { ...s, deviceId: s.deviceId, nextMode: isMode(s.nextMode) ? s.nextMode : undefined } : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(s: Stored): void {
  try {
    const f = stateFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(s));
  } catch (e) {
    console.warn(`[rollout] could not store the decision: ${String(e)}`);
  }
}

// Random v4-style id. Only a bucketing key: it never leaves the device except as the flag
// `targetingKey`.
function newDeviceId(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

function provider(): Provider {
  if (config.flagProvider === "memory") {
    // Local testing without flagd: the build pins the variant (OUO_RUM_MODE).
    return new InMemoryProvider({
      [FLAG_KEY]: {
        variants: { sentry: "sentry", parallel: "parallel", ouo: "ouo" },
        defaultVariant: config.flagMemoryMode,
        disabled: false,
      },
    });
  }
  // OFREP (OpenFeature Remote Evaluation Protocol): flagd serves it, and so do most flag
  // vendors, so the app is not tied to one of them. One bulk evaluation per launch: no polling,
  // no SSE, no localStorage cache (React Native has none; the decision file is the cache).
  return new OFREPWebProvider({
    baseUrl: config.flagUrl,
    timeoutMs: config.flagTimeoutMs,
    pollInterval: 0,
    changeDetection: "none",
    disableVisibilityRefresh: true,
    cacheMode: "disabled",
  });
}

async function evaluate(deviceId: string): Promise<{ mode: RumMode; variant?: string; reason?: string } | undefined> {
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), config.flagTimeoutMs));
  const run = (async () => {
    await OpenFeature.setProviderAndWait(provider(), {
      targetingKey: deviceId,
      appVersion: config.release.split("@")[1]?.split("+")[0] ?? "0.0.0",
      platform: "ios",
    });
    const d = OpenFeature.getClient().getStringDetails(FLAG_KEY, "");
    if (d.errorCode || !isMode(d.value)) {
      console.warn(`[rollout] ${FLAG_KEY}: ${d.errorCode ?? "unknown value"} ${d.errorMessage ?? d.value}`);
      return undefined;
    }
    return { mode: d.value, variant: d.variant, reason: d.reason };
  })().catch((e) => {
    console.warn(`[rollout] flag evaluation failed: ${String(e)}`);
    return undefined;
  });
  return Promise.race([run, timeout]);
}

/**
 * Decides this launch's mode. Resolves synchronously-fast (a microtask) when a previous launch
 * stored a decision; only the very first launch waits for the flag.
 */
export function decideLaunch(): Launch | Promise<Launch> {
  const stored = readStored();
  const deviceId = stored?.deviceId ?? newDeviceId();
  const refresh = (current: Stored): Promise<RumMode | undefined> =>
    evaluate(deviceId).then((r) => {
      if (r) writeStored({ deviceId, nextMode: r.mode, evaluatedAt: new Date().toISOString(), variant: r.variant, reason: r.reason });
      else writeStored(current);
      console.log(`[rollout] next launch: ${r?.mode ?? `${current.nextMode ?? config.defaultMode} (flag unavailable, kept)`}`);
      return r?.mode;
    });

  if (stored?.nextMode) {
    const mode = stored.nextMode;
    return { mode, source: "stored", deviceId, next: refresh(stored) };
  }
  // First launch (or the file was lost): wait for the flag, bounded by flagTimeoutMs.
  return evaluate(deviceId).then((r) => {
    const mode = r?.mode ?? config.defaultMode;
    const s: Stored = { deviceId, nextMode: mode, evaluatedAt: new Date().toISOString(), variant: r?.variant, reason: r?.reason };
    writeStored(s);
    return { mode, source: r ? "flag" : "default", deviceId, next: Promise.resolve(r?.mode) };
  });
}

export const usesSentry = (m: RumMode): boolean => m !== "ouo";
export const usesOuo = (m: RumMode): boolean => m !== "sentry";
