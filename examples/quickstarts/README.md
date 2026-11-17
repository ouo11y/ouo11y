# Quickstarts

Small, standalone apps that show ouo end to end, from an empty folder to the trace in Grafana.
Each brings its own ouo stack, one folder per service. To run ouo for your own app from one
file, use [`deploy/compose/quickstart.yaml`](../../deploy/compose/quickstart.yaml); the
step-by-step adoption guides for your own stack are in [`../fast-tracked/`](../fast-tracked/index.md).

| Quickstart | What it shows |
|---|---|
| [tiny-shop](tiny-shop/README.md) | Express API with the OpenTelemetry Node SDK (auto + manual spans) and a React app with `@ouo11y/browser`: one trace from the click to the API's manual spans, tagged with the RUM session; errors, a crash, replay |
| [tiny-shop-otel](tiny-shop-otel/README.md) ([build it yourself](tiny-shop-otel/build-it-yourself-guide.md)) | Tiny Shop with no ouo SDK in the browser: OpenTelemetry JS, rrweb and web-vitals by hand, sending exactly what ouo reads; the same crashed session, cross-service trace and replay |
| [tiny-shop-funnels](tiny-shop-funnels/README.md) ([build it yourself](tiny-shop-funnels/build-it-yourself-guide.md)) | quickstart 5: page views and custom events as funnel steps; 50 generated sessions; build and read a funnel in Grafana, open the replay of a session that dropped |
| [from-scratch](from-scratch/README.md) (00 to 03) | A series from an empty folder: the stack one service at a time (stock OpenTelemetry Collector, Tempo, Loki, Muninn, Grafana), a React web app, an Expo iOS app, and your own Grafana plugin with a Go backend on `ouo-go` and the replay player of `@ouo11y/kit` |

## Writing a quickstart

The rules every quickstart follows (shape, paths, the stack one folder per service, image
versions, packages, readable telemetry, embeds, verification) are in
[index.md, "Rules for every quickstart"](index.md#rules-for-every-quickstart).
[tiny-shop-otel](tiny-shop-otel/build-it-yourself-guide.md) is the reference.
