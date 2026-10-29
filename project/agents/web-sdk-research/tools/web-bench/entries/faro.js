// Grafana Faro: web instrumentations + OpenTelemetry tracing. Faro has no session replay in these
// packages, so this cell has replay off by construction.
import { initializeFaro, getWebInstrumentations } from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";

const { intake } = window.__BENCH__;
initializeFaro({
  url: `${intake}/faro/collect`,
  app: { name: "web-bench", version: "1.0.0", environment: "bench" },
  instrumentations: [...getWebInstrumentations(), new TracingInstrumentation()],
});
performance.mark("sdk-init-done");
