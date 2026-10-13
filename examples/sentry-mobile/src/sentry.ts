// The only instrumentation in this app: @sentry/react-native with tracing, native sessions and
// mobile Session Replay at 100 %. See README.md for what each action produces.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";

export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

Sentry.init({
  dsn: config.sentryDsn,
  release: config.release,
  dist: config.dist,
  environment: config.environment,
  debug: config.sentryDebug,

  // Tracing: every navigation and fetch is a transaction / span.
  tracesSampleRate: 1.0,
  enableAutoPerformanceTracing: true,
  // sentry-trace + baggage on requests to the demo backend.
  tracePropagationTargets: ["localhost", /^http:\/\/127\.0\.0\.1/],

  // Native release-health sessions (sentry-cocoa), 30 s background timeout by default.
  enableAutoSessionTracking: true,
  enableNativeCrashHandling: true,

  // Mobile Session Replay (sentry-cocoa), default masking (all text and images masked).
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.mobileReplayIntegration(), navigationIntegration],
});

export { Sentry };
