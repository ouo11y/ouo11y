// A stock OpenTelemetry JS SDK client, configured only through the standard OTEL_* variables
// (checklist N15): OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS
// (`Authorization=Basic%20<base64 project:token>`), OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES.
// Sends one span with `ouo.qa.run_id` = argv[2] and exits non-zero when the export fails.
// The packages resolve from the repository's node_modules (they ship with sdk/browser).
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes, envDetector, detectResources } from "@opentelemetry/resources";

const runId = process.argv[2] ?? String(Date.now());
const exporter = new OTLPTraceExporter(); // no options: everything from the environment
let exportError;
const wrapped = {
  export(spans, done) {
    exporter.export(spans, (r) => {
      if (r.code !== 0) exportError = r.error ?? new Error(`export result ${r.code}`);
      done(r);
    });
  },
  shutdown: () => exporter.shutdown(),
  forceFlush: () => exporter.forceFlush(),
};
const resource = resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "unknown_service" }).merge(
  detectResources({ detectors: [envDetector] }),
);
const provider = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(wrapped)] });
const span = provider.getTracer("ouo.qa.stock-sdk").startSpan("qa stock sdk span", { attributes: { "ouo.qa.run_id": runId } });
span.end();
await provider.forceFlush();
await provider.shutdown();
if (exportError) {
  console.error(`export failed: ${exportError.message ?? exportError}`);
  process.exit(1);
}
console.log(JSON.stringify({ run_id: runId, trace_id: span.spanContext().traceId }));
