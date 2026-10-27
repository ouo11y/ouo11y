// @sentry/react-native, pointed at the ouo Sentry bridge. Imported first by index.ts, so the
// SDK starts before the first screen renders and can measure the app start.
import * as Sentry from "@sentry/react-native";
import { API_URL, DIST, ENVIRONMENT, RELEASE, SENTRY_DSN } from "./config";

// One `navigation` transaction per screen change, with the time to initial display (TTID) of
// the new screen. App.tsx registers the navigation container with it.
export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

Sentry.init({
  dsn: SENTRY_DSN,
  // On every session, error, transaction and log: ouo shows them on each record.
  release: RELEASE,
  dist: DIST,
  environment: ENVIRONMENT,

  // Trace every screen and request. Below 1, unsampled requests tell the API not to record
  // its spans (docs/sentry-client-setup.md in the ouo repo, section 3).
  tracesSampleRate: 1.0,
  // Add sentry-trace, baggage and W3C traceparent to requests to the API only: traceparent is
  // what the OpenTelemetry API reads, so app and API spans share one trace.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* (and console.*) as structured logs: one Loki line each.
  enableLogs: true,

  // The defaults that make the mobile vitals, written out so you can find them:
  enableAppStartTracking: true, // app_start_cold / app_start_warm on the first transaction
  enableNativeFramesTracking: true, // frames_total / frames_slow / frames_frozen per transaction
  enableStallTracking: true, // JS event-loop stalls per transaction
  enableNativeCrashHandling: true, // native crashes, reported on the next launch
  enableAutoSessionTracking: true, // one session per foreground use: healthy, errored, crashed
  // A Debug build loads its JavaScript from Metro while the main thread waits, which sentry-cocoa
  // reports as an "App Hang" error on every launch. Watch for hangs in Release builds only.
  enableAppHangTracking: !__DEV__,

  integrations: [navigationIntegration],
});

export { Sentry };
