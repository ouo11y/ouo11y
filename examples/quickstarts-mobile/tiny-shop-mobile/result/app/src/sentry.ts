// @sentry/react-native, configured for the ouo Sentry bridge. Imported first by index.ts, so the
// SDK is running before the first screen renders.
import * as Sentry from "@sentry/react-native";
import { API_URL, SENTRY_DSN } from "./config";

// One `navigation` transaction per screen change (App.tsx registers the navigation container).
export const navigationIntegration = Sentry.reactNavigationIntegration();

Sentry.init({
  dsn: SENTRY_DSN,
  environment: "local",

  // Every transaction is sampled. Below 1, unsampled requests send `traceparent` with flag 00
  // and the API's OpenTelemetry sampler drops their spans.
  tracesSampleRate: 1,
  // Add W3C `traceparent` next to `sentry-trace` and `baggage`, only on requests to the API:
  // the OpenTelemetry SDK in the API reads `traceparent` and joins the app's trace.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* sends structured logs; the bridge turns each into a log record in Loki.
  enableLogs: true,

  integrations: [navigationIntegration],
});

export { Sentry };
