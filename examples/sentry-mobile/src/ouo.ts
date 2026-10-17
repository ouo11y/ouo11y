// Parallel mode (OUO_SDK=1, see app.config.ts): the ouo SDK runs next to Sentry, the way an app
// already on Sentry adopts ouo. Imported after src/sentry (index.ts). Off by default: the app
// is then Sentry only.
import { initRUM, type RUM } from "@ouo/react-native";
import * as Sentry from "@sentry/react-native";
import { config } from "./config";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const ouo: RUM | undefined = config.ouoSdk
  ? initRUM({
      endpoint: config.ouoOtlpEndpoint,
      replayEndpoint: config.ouoReplayEndpoint,
      projectId: config.ouoProjectId,
      projectToken: config.ouoProjectToken,
      service: { name: "sentry-demo-ouo", version: config.release.split("@")[1]?.split("+")[0] ?? "0.0.0", environment: config.environment },
      tracing: { propagateTo: [new RegExp(`^${escapeRegExp(config.backendUrl)}`)] },
      errors: {
        // Hermes keeps one promise rejection tracker and ouo, initialised last, owns it: hand
        // each rejection to Sentry the way Sentry's own tracker would have reported it.
        onUnhandledRejection: (error) =>
          Sentry.captureException(error, { mechanism: { type: "onunhandledrejection", handled: true } }),
      },
      replay: { enabled: config.ouoReplay, maskText: false },
      debug: config.sentryDebug,
    })
  : undefined;
