# sentry / read-apis / fixtures / measurements

| Path | What it is |
|---|---|
| [ingest-latency-runs.json](ingest-latency-runs.json) | Five runs of the ingest-to-API visibility probe |
| [muninn-pull-report.json](muninn-pull-report.json) | Output of `muninn_pull.py` on a web SDK, a mobile and a synthetic replay |
| [routes-26.10.0.json](routes-26.10.0.json) | 253 relevant API routes dumped from Django's URL resolver: class, `publish_status`, scope maps, rate limits |
| [scope-matrix.json](scope-matrix.json) | HTTP status of 30 GET endpoints × 10 tokens (kinds and scopes, no token values) |
| [webhook-halted-restricted-ip.txt](webhook-halted-restricted-ip.txt) | Taskworker log lines showing webhooks halted with `restricted_ip` |
