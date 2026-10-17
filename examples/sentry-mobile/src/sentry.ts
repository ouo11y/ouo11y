// The only instrumentation in this app: @sentry/react-native with tracing, structured logs, native
// sessions and mobile Session Replay at 100 %. See README.md for what each action produces.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";

export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

// Perf-mode launch "ouo only" (config.sentry false): Sentry is linked but never started.
if (config.sentry) Sentry.init({
  dsn: config.sentryDsn,
  release: config.release,
  dist: config.dist,
  environment: config.environment,
  debug: config.sentryDebug,

  // Tracing: every navigation and fetch is a transaction / span.
  tracesSampleRate: 1.0,
  enableAutoPerformanceTracing: true,
  // sentry-trace + baggage on requests to the demo backend, plus W3C `traceparent` so the
  // OpenTelemetry backend joins the app's trace (one trace in Tempo: app spans + backend spans).
  tracePropagationTargets: ["localhost", /^http:\/\/127\.0\.0\.1/],
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
    // Parallel mode: the ouo SDK's own uploads are not app requests.
    ...(config.ouoSdk
      ? [
          Sentry.reactNativeTracingIntegration({
            shouldCreateSpanForRequest: (url) => !url.startsWith(config.ouoOtlpEndpoint) && !url.startsWith(config.ouoReplayEndpoint),
          }),
        ]
      : []),
  ],
});

export { Sentry };
