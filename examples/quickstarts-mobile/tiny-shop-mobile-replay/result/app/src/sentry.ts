// @sentry/react-native, pointed at the ouo Sentry bridge instead of sentry.io, with mobile
// Session Replay. Imported first by index.ts, before any screen.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";

// One `navigation` transaction per screen change (App.tsx registers the navigation container).
export const navigationIntegration = Sentry.reactNavigationIntegration();

Sentry.init({
  dsn: config.sentryDsn,
  environment: "local",
  // Start the native SDK (sentry-cocoa) from JavaScript in every build. It sends everything:
  // JS errors, transactions, sessions and the replay all travel through the native transport.
  autoInitializeNativeSdk: true,

  // Traces: every screen and every tap that calls the API, joined with the API's spans.
  tracesSampleRate: 1,
  tracePropagationTargets: [config.apiUrl], // only our API gets trace headers
  propagateTraceparent: true, // W3C traceparent, which the OpenTelemetry API reads

  // Sentry.logger.* calls become log records (Loki lines in ouo).
  enableLogs: true,

  // Session Replay. A recorded session sends a 5 s video segment at a time, with its taps
  // and breadcrumbs. On-error: a session that was not picked keeps its last minute in memory
  // and sends it when an error is captured.
  replaysSessionSampleRate: config.replaySessionRate,
  replaysOnErrorSampleRate: config.replayOnErrorRate,
  integrations: [
    Sentry.mobileReplayIntegration({
      maskAllText: config.replayMasking,
      maskAllImages: config.replayMasking,
      maskAllVectors: config.replayMasking,
    }),
    navigationIntegration,
  ],
});

export { Sentry };
