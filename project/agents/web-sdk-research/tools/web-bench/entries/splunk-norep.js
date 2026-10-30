// @splunk/otel-web without the session recorder package (a separate entry: importing
// @splunk/otel-web-session-recorder keeps all of it in the bundle even when init is never called).
import SplunkRum from "@splunk/otel-web";

const { intake } = window.__BENCH__;
SplunkRum.init({
  beaconEndpoint: `${intake}/splunk/v1/rumotlp`,
  exporter: { otlp: true },
  rumAccessToken: "benchtoken",
  applicationName: "web-bench",
  deploymentEnvironment: "bench",
  version: "1.0.0",
  allowInsecureBeacon: true,
});
performance.mark("sdk-init-done");
