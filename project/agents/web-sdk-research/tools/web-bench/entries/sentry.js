// @sentry/browser: tracing + replay at 100 %, defaults otherwise (replay masks all text and inputs,
// blocks media; compression in a worker).
import * as Sentry from "@sentry/browser";

const { intake } = window.__BENCH__;
const port = new URL(intake).port;
Sentry.init({
  dsn: `http://benchpublickey@127.0.0.1:${port}/sentry/1`,
  release: "web-bench@1.0.0",
  environment: "bench",
  integrations: [Sentry.browserTracingIntegration(), ...(__REPLAY__ ? [Sentry.replayIntegration()] : [])],
  tracesSampleRate: 1,
  replaysSessionSampleRate: __REPLAY__ ? 1 : 0,
  replaysOnErrorSampleRate: __REPLAY__ ? 1 : 0,
});
performance.mark("sdk-init-done");
