# RN replay over OTLP on the iOS Simulator (2026-11-12)

`examples/ouo-mobile` Release build on an iPhone 18 Pro simulator (iOS 27.0), `replay.mode: "pixel/frames"`,
`maskText: false` (demo default), demo backend on :8081, `scripts/fake-collector.mjs` on :24318.

- [verdict-journey.txt](verdict-journey.txt) — fake Collector verdict after `scripts/journey.sh` and a second launch: every rule passes, previous stream ended `partial/background_kill`, replay `session.id` = telemetry `session.id`
- [verdict-503-retry.txt](verdict-503-retry.txt) — the same with `--status 503 --retry-after 2 --fail-first 3`: the replay end record answered 503 twice is accepted on its third try, about 2 s apart, verdict PASS
- [requests-503-then-200.jsonl](requests-503-then-200.jsonl) — every request while the collector answered 503 to everything, then 200: the 43678-byte chunk (seq 1) arrives with the sha256 it had when refused
- [requests-400.jsonl](requests-400.jsonl) — every request while the collector answered 400: each replay chunk is sent once and dropped, the app keeps running
- [frame-product-image-masked.jpg](frame-product-image-masked.jpg) — a `frame` of the product screen: product photo masked (black), labels readable (maskText false), native header masked
- [frame-cart-inputs-masked.jpg](frame-cart-inputs-masked.jpg) — a `frame` of the cart screen: both feedback text inputs masked, labels and totals readable

## Second pass (2026-11-13): default masking, normal ends, capture cadence

Build: `OUO_CONFORMANCE=1 OUO_DEBUG=1` (SDK default masking, the native replay debug log in Release).

- [frame-default-text-masked.jpg](frame-default-text-masked.jpg) — the cart after `action/type` filled the feedback field (a frame plus a patch): every label, price, button title and both inputs masked; the layout still reads as the cart. The product title on the product screen is readable only because the demo marks it `testID="ouo-unmask"`
- [verdict-normal-end.txt](verdict-normal-end.txt) — verdict PASS. `action/shutdown` ends a stream `complete/session_end/last=2`. A 65 s background rotates the session: the old stream ends `complete/session_end/last=2` and a new stream starts with a keyframe
- [journey-normal-end.txt](journey-normal-end.txt) — command times of that run
- [look-timing-debug-log.txt](look-timing-debug-log.txt) — the recorder's debug log during `journey.sh`: one look per second (48 looks), main thread 14–27 ms each (median 17 ms), well within the 100 ms per second time budget. A look that finds nothing changed adds no event, which accounts for the gaps between events in the chunks. Each screen change appears in the replay 1.0–1.3 s after its journey command

## Third pass (2026-11-13): after the PR 184 review fixes (97d046e2..0975888c)

Conformance build (default masking), `OUO_DEBUG=1`, fresh simulator, demo backend, fake Collector.

- [verdict-review-frames.txt](verdict-review-frames.txt) — `pixel/frames`, `journey.sh` then a second launch: verdict PASS. The previous stream ends `partial/background_kill/last=5`
- [frame-review-cart-masked.jpg](frame-review-cart-masked.jpg) — a frame of the cart from that run: labels, prices, button titles and inputs masked
- [verdict-review-video.txt](verdict-review-video.txt) — `pixel/video`, the same journey: verdict PASS. 9 `ouo-video/1` chunks, each one keyframed segment; every mp4 opens in AVFoundation (402x874, 1 fps, 5–6 s)
- [frame-video-product-masked.jpg](frame-video-product-masked.jpg) — a frame read from an mp4 chunk (product screen after a push): the photo, price and button title are masked
- [consent-withdrawal.txt](consent-withdrawal.txt) — the commands and `requests.jsonl` of `action/consent?replay=false` on both builds. No replay request arrives between the withdrawal and the relaunch, telemetry keeps flowing, and the withdrawn stream never gets an `ouo.replay.ended`, not even on the next launch
