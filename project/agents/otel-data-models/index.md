# otel-data-models

Step 1 of the post-MVP plan: understand the OpenTelemetry data models of logs, traces and metrics, from primary sources.

- Owns: `project/kb/opentelemetry/`.
- Does not decide RUM semantic conventions. That is Step 2.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [HTML explainer](../../kb/opentelemetry/data-models-explainer.html) | Diagrams and plain explanation, kept with the kb entries |
| [scripts/wire_size.py](scripts/wire_size.py) | Measures OTLP wire size of one fact as log, event, span and metric |
| [scripts/backend_checks.py](scripts/backend_checks.py) | Tests Collector and Loki edge cases against running containers |
