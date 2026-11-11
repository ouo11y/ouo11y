# posthog / wire-format / fixtures

Captured web requests (token redacted), listed in the wire-format entry

| Path | What it is |
|---|---|
| [web-e-pageview.json](web-e-pageview.json) | First `$pageview` to `/e/`, full property list |
| [web-exceptions.json](web-exceptions.json) | Four `$exception` mechanisms |
| [web-flags-v2.json](web-flags-v2.json) | `/flags/?v=2` body after identify |
| [web-i-v0-e-batch.json](web-i-v0-e-batch.json) | One of each: `$identify`-era `$autocapture`, `$rageclick`, `$$heatmap`, `$web_vitals`, manual event |
| [web-i-v1-logs-otlp.json](web-i-v1-logs-otlp.json) | OTLP/JSON logs from console capture |
| [web-remote-config.json](web-remote-config.json) | Config request headers plus our mock config (server keys) |
| [web-retry-500.json](web-retry-500.json) | The same event retried with `retry_count` after forced 500s |
| [web-s-snapshot-decoded.json](web-s-snapshot-decoded.json) | Decoded selection of every rrweb event type seen |
| [web-s-snapshot-raw.json](web-s-snapshot-raw.json) | `/s/` as sent, with compressed `cv 2024-10` fields |
| [web-unload-beacons.json](web-unload-beacons.json) | sendBeacon flush at navigation |
