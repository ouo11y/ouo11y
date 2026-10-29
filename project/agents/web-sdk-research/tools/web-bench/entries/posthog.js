// posthog-js: npm module, defaults (autocapture, pageviews, recorder lazily loaded from api_host).
// Recording is enabled by the remote config the intake returns (server.mjs POSTHOG_CONFIG).
import posthog from "posthog-js";

const { intake } = window.__BENCH__;
posthog.init("phc_bench", {
  api_host: `${intake}/ph`,
  disable_session_recording: !__REPLAY__,
  // Headless Chromium carries a "HeadlessChrome" UA-CH brand, which PostHog's bot filter drops
  // (every event and snapshot). A real browser passes the filter; this only undoes the headless tell.
  opt_out_useragent_filter: true,
});
performance.mark("sdk-init-done");
