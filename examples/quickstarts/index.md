# Quickstarts

Small, standalone apps you run against the one-file stack
([`deploy/compose/quickstart.yaml`](../../deploy/compose/quickstart.yaml)) to see ouo end to end.
Each folder works on its own, inside or outside this repo, and its README goes from an empty
terminal to the trace in Grafana. The step-by-step adoption guides for your own stack are in
[`../fast-tracked/`](../fast-tracked/index.md).

| Quickstart | What it shows |
|---|---|
| [tiny-shop](tiny-shop/README.md) | Express API with the OpenTelemetry Node SDK (auto + manual spans) and a React app with `@ouo11y/browser`: one trace from the click to the API's manual spans, tagged with the RUM session; errors, a crash, replay. Run it as is, or [build it yourself from scratch](tiny-shop/build-it-yourself-from-scratch.md) |
