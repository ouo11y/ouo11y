# Mobile replay: new evidence from Step 6

What did Step 6 measure or read about video, wireframe and screenshot mobile replay? Evidence only; the format is **not decided** here. This adds to Step 4's [mobile-replay-format-evidence.md](../client-sdk-features/mobile-replay-format-evidence.md), which collects vendor-published numbers. Researched 2026-11-10. Every row links to the entry that holds the method and source.

## Bytes on the wire

| Vendor, format | Setup | Bytes | Status | Source |
|---|---|---|---|---|
| Sentry, H.264 video, 1 fps, 5 s segments, `medium` quality | iOS simulator, `@sentry/react-native` 8.34.0, 2-minute scripted journey, default masking | **165 KB/min** (415 KB/min unmasked) | observed | [sentry/mobile-sdks/replay-mobile.md](sentry/mobile-sdks/replay-mobile.md) |
| Sentry, same | Android emulator, same app and journey, default masking | **212 KB/min** (421 KB/min unmasked) | observed | same |
| Sentry, idle screen | Android, static screen at 1 fps | about 7 KB/s (36,214 bytes per 5 s segment) | observed | same |
| Datadog, wireframe records | iOS simulator, dd-sdk-ios 3.21.0, one simple UIKit screen plus one push, masked, about 15 s | about **34 KB/min** | observed (short run, simple screen) | [datadog/mobile-sdks/mobile-replay-wireframes.md](datadog/mobile-sdks/mobile-replay-wireframes.md) |
| PostHog, wireframe | node tree; iOS sends a full snapshot per changed frame, Android sends diffs | about 1–5 KB per frame | inferred from the schema and a web proxy, not measured on a device | [posthog/mobile-sdks/replay-wireframe-vs-screenshot.md](posthog/mobile-sdks/replay-wireframe-vs-screenshot.md) |
| PostHog, screenshot | one WebP q30 image per frame, carried base64 in the JSON | WebP 6.8–23 KB per frame; base64 in the JSON 9–31 KB (up to 76 KB at native 3× scale); the request's gzip shrinks base64 back to about the WebP size (inferred). About 1.2 MB/min at 1 frame/s of constant change (inferred upper bound) | inferred from web pages standing in for app screens | same |

The Sentry and Datadog rows used different apps, screens and lengths. They are not a like-for-like comparison.

## What else the evidence shows

- **Masking changes video cost a lot.** Sentry's default masking (text, images, vectors) cut wire bytes by 60 % on iOS and 50 % on Android, because masked boxes are flat and compress well ([replay-mobile.md](sentry/mobile-sdks/replay-mobile.md)).
- **Video has a floor.** A static screen still costs about 7 KB/s on Android at 1 fps. PostHog's iOS SDK skips a frame whose hash is unchanged, in both wireframe and screenshot mode (source). Datadog's observed 34 KB/min was on a mostly static screen. Its docs give averages for real apps of about 12 KB/s on iOS (about 720 KB/min, 1.7 to 4.4 times the Sentry rates measured above) and 1.22 KB/s on Android (about 73 KB/min) ([mobile-replay-wireframes.md](datadog/mobile-sdks/mobile-replay-wireframes.md)).
- **The non-video part of a Sentry replay** (breadcrumbs, touches, and the `replay_event` JSON repeated on every segment) is 18–19 % of the uncompressed envelope bytes with default masking and 8–11 % unmasked ([replay-mobile.md](sentry/mobile-sdks/replay-mobile.md)).
- **Masking happens on the device for every vendor.** Datadog replaces text with `x` runs, inputs with `***` and images with placeholders ([mobile-replay-wireframes.md](datadog/mobile-sdks/mobile-replay-wireframes.md)). PostHog's `maskAllTextInputs` masks all text, labels included ([replay-wireframe-vs-screenshot.md](posthog/mobile-sdks/replay-wireframe-vs-screenshot.md)).
- **Reliability differs.** Sentry pauses replay while offline or rate-limited, so the recording has a gap, and recovers a crashed segment at the next launch (iOS from PNG frames, Android from `replay_<id>/.ongoing_segment`) ([ios/reliability.md](sentry/mobile-sdks/ios/reliability.md), [android/reliability.md](sentry/mobile-sdks/android/reliability.md)). Datadog writes batches to disk first, and data from a killed, offline iOS session arrived on relaunch ([datadog/mobile-sdks/ios.md](datadog/mobile-sdks/ios.md)).
- **Reading replays back.** Sentry stores a video segment as zlib of the MP4 bytes plus the rrweb JSON, and serves it through an experimental video endpoint ([self-hosted-storage/object-storage.md](sentry/self-hosted-storage/object-storage.md), [read-apis/replays.md](sentry/read-apis/replays.md)). Datadog documents a segment download API but not the payload format ([datadog/apis/read-apis.md](datadog/apis/read-apis.md)).

## Not measured

- Real devices: none were used.
- CPU, memory and battery cost of each format: Step 5 owns overhead.
- PostHog mobile on a device, and Datadog on Android.
