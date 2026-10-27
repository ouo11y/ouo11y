// @sentry/react-native, set up as a team that already uses Sentry would have it. The DSN comes
// from app/.env: your Sentry DSN, or the same key and project with the ouo bridge as host.
import * as Sentry from "@sentry/react-native";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (!dsn) throw new Error("EXPO_PUBLIC_SENTRY_DSN is not set: add it to app/.env and restart Metro");
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

export const navigationIntegration = Sentry.reactNavigationIntegration({ enableTimeToInitialDisplay: true });

Sentry.init({
  dsn,
  environment: "local",
  // Start sentry-cocoa from JS. Without it a Release build can skip the native start and send
  // nothing at all, to Sentry or to ouo (docs/sentry-client-setup.md, section 1).
  autoInitializeNativeSdk: true,

  // Every screen and request is traced; 1.0 keeps the API's spans too (step 7).
  tracesSampleRate: 1.0,
  // Step 7: the API is OpenTelemetry, which reads W3C `traceparent`, not `sentry-trace`. Send
  // both, and only to the API.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* calls become Sentry Logs (and log lines in ouo).
  enableLogs: true,

  // Mobile Session Replay on every session; Sentry's default masking (all text and images).
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.mobileReplayIntegration(), navigationIntegration],
});

export { Sentry };
