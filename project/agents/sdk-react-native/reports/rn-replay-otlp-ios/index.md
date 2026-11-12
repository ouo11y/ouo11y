# RN replay over OTLP on the iOS Simulator (2026-11-12)

`examples/ouo-mobile` Release build on an iPhone 18 Pro simulator (iOS 27.0), `replay.mode: "pixel/frames"`,
`maskText: false` (demo default), demo backend on :8081, `scripts/fake-collector.mjs` on :24318.

- [verdict-journey.txt](verdict-journey.txt) — fake Collector verdict after `scripts/journey.sh` and a second launch: every rule passes, previous stream ended `partial/background_kill`, replay `session.id` = telemetry `session.id`
- [verdict-503-retry.txt](verdict-503-retry.txt) — the same with `--status 503 --retry-after 2 --fail-first 3`: the replay end record answered 503 twice is accepted on its third try, about 2 s apart, verdict PASS
- [requests-503-then-200.jsonl](requests-503-then-200.jsonl) — every request while the collector answered 503 to everything, then 200: the 43678-byte chunk (seq 1) arrives with the sha256 it had when refused
- [requests-400.jsonl](requests-400.jsonl) — every request while the collector answered 400: each replay chunk is sent once and dropped, the app keeps running
- [frame-product-image-masked.jpg](frame-product-image-masked.jpg) — a `frame` of the product screen: product photo masked (black), labels readable (maskText false), native header masked
- [frame-cart-inputs-masked.jpg](frame-cart-inputs-masked.jpg) — a `frame` of the cart screen: both feedback text inputs masked, labels and totals readable
