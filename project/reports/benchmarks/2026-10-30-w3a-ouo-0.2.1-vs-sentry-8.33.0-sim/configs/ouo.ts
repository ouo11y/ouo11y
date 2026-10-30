// The ouo SDK, initialised by index.ts in the `parallel` and `ouo` rollout modes
// (src/rollout.ts), always AFTER Sentry when both run: ouo then owns Hermes' single promise
// rejection tracker (and forwards rejections to Sentry) and its fetch / XHR wrappers run first,
// so ouo's traceparent is the one the backend gets (project/kb/ouo-next-to-sentry.md).
import { initRUM, type RUM } from "@ouo11y/react-native";
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import { perfOuoReplay } from "./perf";
import { FLAG_KEY, usesSentry, type RumMode } from "./rollout";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export let ouo: RUM | undefined;

export function initOuo(mode: RumMode, replay: boolean): RUM {
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
    replay: perfOuoReplay() ?? { enabled: replay, maskText: false }, // benchmark tiers only (src/perf.ts)
    debug: config.sentryDebug,
  });
  return ouo;
}
