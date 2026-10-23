// The ouo SDK, initialised by index.ts in the `parallel` and `ouo` rollout modes
// (src/rollout.ts), always AFTER Sentry when both run: ouo then owns Hermes' single promise
// rejection tracker (and forwards rejections to Sentry) and its fetch / XHR wrappers run first,
// so ouo's traceparent is the one the backend gets (project/kb/ouo-next-to-sentry.md).
import { initRUM, type RUM } from "@ouo11y/react-native";
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import { FLAG_KEY, usesSentry, type RumMode, type Tier } from "./rollout";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export let ouo: RUM | undefined;

// Benchmark tiers (docs/benchmarks.md, OUO_PERF=1 builds only). ouo has no errors-only setup (its
// fetch tracing is always on): T1 runs as T2. T3: replay with the SDK's defaults (masking on).
// T4: 1 frame/s (the default), masking off, as Sentry's T4.
const replayForTier = (tier: Tier, replay: boolean) =>
  !replay || tier === "T1" || tier === "T2"
    ? { enabled: false }
    : tier === "T3"
      ? { enabled: true }
      : { enabled: true, frameInterval: 1, maskText: false, maskInputs: false, maskImages: false, maskWebViews: false };

export function initOuo(mode: RumMode, replay: boolean, tier?: Tier): RUM {
  ouo = initRUM({
    endpoint: config.ouoOtlpEndpoint,
    replayEndpoint: config.ouoReplayEndpoint,
    projectId: config.ouoProjectId,
    projectToken: config.ouoProjectToken,
    service: { name: "sentry-demo-ouo", version: config.release.split("@")[1]?.split("+")[0] ?? "0.0.0", environment: config.environment },
    // The cohort on every span and log record, so dashboards can split by it. Sentry-bridged
    // data carries `ouo.rum.mode = sentry` (set by the bridge).
    resource: { [FLAG_KEY]: mode },
    tracing: {
      propagateTo: [new RegExp(`^${escapeRegExp(config.backendUrl)}`)],
      ignoreUrls: [new RegExp(`^${escapeRegExp(config.flagUrl)}`)],
    },
    errors: usesSentry(mode)
      ? {
          // Hermes keeps one promise rejection tracker and ouo, initialised last, owns it: hand
          // each rejection to Sentry the way Sentry's own tracker would have reported it.
          onUnhandledRejection: (error) =>
            Sentry.captureException(error, { mechanism: { type: "onunhandledrejection", handled: true } }),
        }
      : {},
    // `parallel`: Sentry's replay keeps recording; a second recorder doubles the capture cost
    // on the device (project/kb/sdk-overhead-ios.md), so ouo replay is off. `ouo`: ouo is the only
    // recorder. `replay` is that rule, except in a perf run that forces it (src/rollout.ts).
    replay: tier ? replayForTier(tier, replay) : { enabled: replay, maskText: false },
    debug: config.sentryDebug,
  });
  return ouo;
}
