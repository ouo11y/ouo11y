// @sentry/react-native with tracing, structured logs, native sessions and mobile Session Replay
// at 100 %. See README.md for what each action produces. Initialised by index.ts in the
// `sentry` and `parallel` rollout modes only (src/rollout.ts); in `ouo` mode Sentry.init is
// never called and every Sentry.* call in the app is a no-op.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import type { RumMode } from "./rollout";

export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

/** URLs that are SDK or flag traffic, not app requests: never traced by either SDK. */
export const isMonitoringUrl = (url: string): boolean =>
  url.startsWith(config.ouoOtlpEndpoint) || url.startsWith(config.ouoReplayEndpoint) || url.startsWith(config.flagUrl);

export function initSentry(mode: RumMode): void {
  Sentry.init({
    // `sentry`: through the ouo Sentry bridge, which forwards every envelope to Sentry and
    // translates a copy into ouo. `parallel`: straight to Sentry, because the ouo SDK already
    // reports these sessions to ouo and the bridge would add each one a second time.
    dsn: mode === "parallel" ? config.sentryDirectDsn : config.sentryDsn,
    release: config.release,
    dist: config.dist,
    environment: config.environment,
    debug: config.sentryDebug,
    // Start sentry-cocoa from JS even when the build has a sentry.options.json. The Expo plugin
    // writes that file when SENTRY_ENVIRONMENT is set at prebuild, and @sentry/react-native 8 then
    // skips the native start in Release builds, expecting AppDelegate to do it: no envelope is ever
    // sent (docs/sentry-client-setup.md, section 1).
    autoInitializeNativeSdk: true,
    // The cohort, searchable in Sentry as `ouo.rum.mode:parallel`.
    initialScope: { tags: { "ouo.rum.mode": mode } },

    // Tracing: every navigation and fetch is a transaction / span.
    tracesSampleRate: 1.0,
    enableAutoPerformanceTracing: true,
    // sentry-trace + baggage on requests to the demo backend, plus W3C `traceparent` so the
    // OpenTelemetry backend joins the app's trace (one trace in Tempo: app spans + backend spans).
    // Only the backend: a bare "localhost" would also match the collector and flag URLs
    // (docs/sentry-client-setup.md). tracesSampleRate stays 1.0: below it, unsampled requests send
    // `traceparent` flag 00 and the backend's ParentBased sampler drops their spans.
    tracePropagationTargets: [config.backendUrl],
    // In parallel mode ouo, initialised after Sentry, sets `traceparent` first and Sentry then
    // adds none of its own: one per request whatever this option says.
    propagateTraceparent: true,

    // Sentry structured logs (`log` envelope items): Sentry.logger.* in src/actions.ts and the screens.
    enableLogs: true,

    // Native release-health sessions (sentry-cocoa), 30 s background timeout by default.
    enableAutoSessionTracking: true,
    enableNativeCrashHandling: true,

    // Mobile Session Replay (sentry-cocoa). Demo only: masking is off so the recordings show the
    // real screens. The demo shows no personal data; keep the defaults (all masked) in a real app.
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.mobileReplayIntegration({ maskAllText: false, maskAllImages: false, maskAllVectors: false }),
      navigationIntegration,
      // The ouo SDK's uploads and the flag request are not app requests.
      Sentry.reactNativeTracingIntegration({ shouldCreateSpanForRequest: (url) => !isMonitoringUrl(url) }),
    ],
  });
}

export { Sentry };
