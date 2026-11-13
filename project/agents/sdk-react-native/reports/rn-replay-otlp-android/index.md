# RN replay over OTLP on an Android emulator (2026-11-12)

Session replay of `@ouo11y/react-native` (`replay.mode: "pixel/frames"`, ADR-0021 decision 5) run end to end on an Android 15 emulator (arm64 Google APIs, Pixel 6 profile, 1080x2400 at 420 dpi). The app was `examples/ouo-mobile`, built Release with `scripts/build-android.sh --conformance` and `EXPO_PUBLIC_OTLP_ENDPOINT=http://10.0.2.2:25318`. It was driven by `scripts/journey-android.sh` and checked by `scripts/fake-collector.mjs`. Mask options were the conformance build's: every default (`maskText`, `maskInputs`, `maskImages`, `maskWebViews` all true). The checkout promo field also carries `testID="ouo-mask"`, and the product title carries `testID="ouo-unmask"`.

Files:

- [journey-run1.txt](journey-run1.txt): run 1, the journey without a backend (screens show their error state). PASS.
- [journey-run2.txt](journey-run2.txt): run 2, the journey with a stub backend, then 70 s in the background and a resume (the session rotates in-process). PASS.
- [fault-503.txt](fault-503.txt): run 3, `--status 503 --retry-after 2 --fail-first 3`. PASS. The faulted `ouo.replay.ended` request was retried later with the same bytes.
- [fault-400.txt](fault-400.txt): run 4, `--status 400`. Chunks 3 and 4 were rejected and dropped, and never sent again. The collector then answered 200 again and got chunk 5. The `sequence` FAIL is expected there: 0 to 2 went to the run-3 collector, and 3 and 4 were dropped. The stream later ended `partial/session_end`, as RPL-21 requires after a loss.
- [frame-product-image-masked.jpg](frame-product-image-masked.jpg): a decoded patch of the Product screen. The image (96 dp) is black, the price is black, the button label is black, and the title "Product 1001" is readable (`ouo-unmask`).
- [frame-checkout-input-masked.jpg](frame-checkout-input-masked.jpg): a decoded keyframe of the Checkout screen after `SECRET4242` was typed into the promo field. The input and every label are black, and no typed text can be read.

Results:

| Check | Result | Evidence |
|---|---|---|
| One OTLP protobuf request per chunk to `/v1/logs`, no `Content-Encoding` | pass | rules `one_chunk_per_request`, `no_content_encoding` |
| Scope `ouo.replay` 0.3.0, events `ouo.replay.chunk` / `ouo.replay.ended`, schema URL | pass | records.jsonl of each run |
| Every MUST attribute of 11.3 present and typed; sha256 and byte_size match | pass | `chunk_attributes`, `hash_and_size` |
| Sequence from 0 by 1 per stream; keyframe first in each segment | pass | `sequence`, `keyframe` (runs 1 to 3) |
| `ouo.replay.ended` with `end_state`, `last_sequence`, `end_reason` | pass | `partial/background_kill` after a force-stop (next launch), `complete/session_end` on rotation, `partial/session_end` after a 400 loss |
| Replay `session.id` equals telemetry `session.id` | pass | `telemetry session.id` line versus the stream records (same ids per launch and after rotation) |
| 503 + Retry-After: same bytes retried later, no crash | pass | `faulted replay request ...: retried same_bytes` |
| 400: dropped, app keeps running | pass | seq 3 and 4 never resent; same pid 5446 before and after |
| No crash or ANR | pass | `adb logcat -b crash` empty; no `ANR in` / `FATAL EXCEPTION` in logcat; `dumpsys activity processes` shows no crash or not-responding state |
| Touch coordinates line up with frames | pass | the tap at (540, 738) px became a touch at (205.71, 281.14) dp. Times `scale` 1.09, that is (224, 306) in frame pixels, the centre of the masked promo input |

Not verified here: the exact Retry-After wait (the collector logs no times); `pixel/video` and `structure/wireframe` (not in this build); buffer mode (`replay.buffer`); web views (the app has none). The keyboard is a separate window and is not in the frames.
