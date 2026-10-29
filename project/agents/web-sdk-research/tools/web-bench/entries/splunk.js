// @splunk/otel-web (+ @splunk/otel-web-session-recorder for replay): defaults except OTLP export
// (below); the recorder masks all text and inputs by default.
import SplunkRum from "@splunk/otel-web";
import SplunkSessionRecorder from "@splunk/otel-web-session-recorder";

const { intake } = window.__BENCH__;
SplunkRum.init({
  // OTLP export, the documented path (the default Zipkin export logs a deprecation warning).
  beaconEndpoint: `${intake}/splunk/v1/rumotlp`,
  exporter: { otlp: true },
  rumAccessToken: "benchtoken",
  applicationName: "web-bench",
  deploymentEnvironment: "bench",
  version: "1.0.0",
  allowInsecureBeacon: true, // the local intake is http://127.0.0.1; Splunk refuses plain http otherwise
});
SplunkSessionRecorder.init({ beaconEndpoint: `${intake}/splunk/v1/rumreplay`, rumAccessToken: "benchtoken" });
performance.mark("sdk-init-done");
