// @datadog/browser-rum: sessions and replay at 100 %, defaults otherwise (defaultPrivacyLevel
// "mask-user-input", user interactions, resources and long tasks tracked by default). All requests go to the
// local intake through the documented `proxy` option.
import { datadogRum } from "@datadog/browser-rum";

const { intake } = window.__BENCH__;
datadogRum.init({
  applicationId: "00000000-0000-4000-8000-000000000000",
  clientToken: "pub00000000000000000000000000000000",
  site: "datadoghq.com",
  service: "web-bench",
  env: "bench",
  version: "1.0.0",
  proxy: `${intake}/dd`,
  sessionSampleRate: 100,
  sessionReplaySampleRate: __REPLAY__ ? 100 : 0,
});
performance.mark("sdk-init-done");
