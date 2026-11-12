# `structure/wireframe`: which wireframe schema and which player

- **Date:** 2026-11-12. Evidence is read from source at the tags below (shallow, read-only clones, nothing executed). Earlier research is not repeated: see [mobile-replay-wireframes.md](../../vendor-internals/datadog/mobile-sdks/mobile-replay-wireframes.md), [replay-wireframe-vs-screenshot.md](../../vendor-internals/posthog/mobile-sdks/replay-wireframe-vs-screenshot.md), [mobile-replay-evidence.md](../../vendor-internals/mobile-replay-evidence.md) and [mobile-replay-format-evidence.md](../../client-sdk-features/mobile-replay-format-evidence.md).
- **Tags read:** dd-sdk-ios 3.22.0, dd-sdk-android 3.16.0, dd-sdk-reactnative 3.11.0 (all Apache-2.0); posthog-ios 3.94.4, posthog-android android-v6.5.0, `PostHog/posthog` at `4f029c3` (all MIT outside `ee/`).
- **Context:** [ADR-0021](../../../../docs/adr/0021-react-native-sdk-keep-and-extend.md) decisions 5 and 6. Chunk rules: RPL-6, RPL-7, RPL-24, RPL-27 in [sdk-spec.md](../../opentelemetry/rum-semantic-conventions/sdk-spec.md#11-replay-contract).

## The question

For `replay.mode = structure/wireframe` on iOS and Android, with Datadog's native recorders as the base: which schema goes on the wire, and which player draws it? Web already ships `structure/dom` (`rrweb/2`) and the Grafana plugin plays rrweb.

## The three options

| | Recorder | Wire format | Player |
|---|---|---|---|
| **A** | Datadog's | Datadog's wireframe records, as is | A Datadog-style wireframe player of our own, beside the rrweb player |
| **B** | Datadog's, patched to emit rrweb events | rrweb (`rrweb/2`) from the device | The existing rrweb player |
| **C** | Datadog's, unchanged apart from the output seam | Datadog's wireframe records (`ouo-wireframe/1`) | A decoder in the reader turns records into rrweb events, then the existing rrweb player |

## What the code showed (new facts)

1. **PostHog does not put rrweb on the wire from mobile.** The SDKs send their own wireframe node tree (`RRWireframe`, types `text`, `input`, `image`, `rectangle`, `div`, `screenshot`) wrapped in rrweb-style event numbers. The conversion to rrweb DOM nodes is `common/replay-shared/src/mobile/transformer/` in the shared player package: 2 395 lines of TypeScript, MIT, run at playback. So "PostHog's model" is option **C**, not B.
2. **Datadog's player is not open source.** `DataDog/browser-sdk` holds the web recorder and the event types only; `rum-events-format` (Apache-2.0) holds the schemas (32 JSON files for the mobile segment, 32 KB on the Android side). I found no mobile wireframe renderer in any Datadog repository. Option A therefore means writing a wireframe player anyway, with nothing to copy.
3. **Datadog's recorders do not read React Native text.** iOS `DatadogSessionReplay` has no `RCT*` code at all. `dd-sdk-reactnative/packages/react-native-session-replay` adds the RN part: iOS 1 308 lines (`RCTTextViewRecorder.swift`, `RCTTextExtractor.mm`, `RCTFabricWrapper.mm`, `SvgViewRecorder.swift`, `DdPrivacyOverrider.swift`, Fabric and Paper privacy views) and Android 42 Kotlin files, 3 043 lines (`ReactTextMapper`, `ReactEditTextMapper`, `ReactViewGroupMapper`, `ReactNativeImageViewMapper`, `ReactViewModalMapper`, `SvgViewMapper`, drawable and text-layout reflection, per-RN-version source sets `rnlegacy`, `rn69`, `rn80`, `oldarch`). The iOS text recorder reads the text from `RCTUIManager` or the Fabric shadow tree, because the view is not a `UILabel`. So borrowing from two repositories is not enough: it is three.
4. **Static text masks as `x` runs, not `***`.** `maskAll` uses `SpacePreservingMaskObfuscator` (word lengths and spaces survive) for labels and `FixLengthMaskObfuscator` (`***`) for inputs and hints (`PrivacyLevel.swift`, `Processor/Privacy/TextObfuscator.swift`). Our spec says `***`: a one-line patch of the static-text obfuscator on each platform.
5. **Android is more tangled with Datadog core.** The Android session-replay module imports `com.datadog.android.api` 121 times (logger, feature SDK core, storage), against 61 `DatadogInternal` imports in iOS. The output seam is larger there than the Sentry one.
6. **Images are a side channel.** Datadog uploads images as separate hashed resources (`ResourceRequestBuilder`, `ResourcesFeature`, `resourceId` on image wireframes). Our chunk contract has one body per chunk, so v1 of `ouo-wireframe/1` keeps every image as a `placeholder`.

## Comparison

| | A: adopt as is | B: Datadog recorders, emit rrweb | C: Datadog recorders, Datadog records on the wire, convert in the reader |
|---|---|---|---|
| **Copied** | Same as C | Same as C, plus patches to emit rrweb | iOS: `Recorder/` (83 files, 7 450 lines), `Processor/` (9, 1 574), a trimmed `SRDataModels` (3 138 generated). Android: recorder, mappers, processor and the models from the schemas. RN: the two `dd-sdk-reactnative` native parts. Exact lists below |
| **Licence** | Apache-2.0 for every file, keep headers, copy each repository's `NOTICE` text into ours (iOS and Android `NOTICE` are the short "developed at Datadog" text). Add a `NOTICE` line per repository | Same | Same. A PostHog transformer would be MIT, but C does not copy it: we write a 300 to 500 line converter (an estimate) for Datadog's smaller type set |
| **Fits the chunk contract** (RPL-6, RPL-7) | Yes. A segment is `Meta`, `Focus`, full snapshot, then diffs, as NDJSON | Possible, but the device must hold a stable rrweb node-id and parent map to turn Datadog diffs into rrweb mutations. A bug there breaks the keyframe rule | Yes, as A. Keyframe = the three records Datadog already emits on each new view; the SDK forces one at each segment start (RPL-8, RPL-9) |
| **Masking** (`***`, secure fields, `ouo-mask`, `ouo-unmask`) | Same recorder logic; patch the obfuscator | Same | Same. Secure fields: iOS `isSecureTextEntry` and sensitive content types, Android password, email and numeric-password input types, all always masked by Datadog. `ouo-mask` and `ouo-unmask` map onto Datadog's `maskAll`/`maskNone`/`hide` overrides: iOS `sessionReplayPrivacyOverrides`, RN `DdPrivacyOverrider` and the privacy views |
| **React Native** | Needs the RN additions (point 3) | Same, plus conversion code in three more places | Same additions, left unpatched |
| **Player effort** | New wireframe player, no reference to copy | None | One decoder in the reader (RPL-24) feeding the rrweb player. PostHog's transformer is the worked example |
| **What the rrweb view loses** | n/a | Fonts (family string to a CSS stack), real images (placeholders), SwiftUI and Compose unless their modules are vendored, canvas, maps, video. Same loss in B and C: the recorder decides it, not the player | Same |
| **Device cost** | Datadog's documented figures: about 3 ms main thread per capture, capture every 64 to 100 ms, about +200 kB iOS, AAR 480 kB, 12 KB/s iOS and 1.22 KB/s Android averages. Our own device figures do not exist yet | Adds node-id bookkeeping and rrweb serialisation on the device, twice (Swift, Kotlin), unmeasured | As A, nothing added on the device |
| **Wire size** | Observed 34 KB/min on one masked UIKit screen; docs say 12 KB/s iOS in real apps | rrweb mutation JSON is larger than flat wireframes (inferred) | As A |
| **Staying in sync** | Commits in the last 12 months on the borrowed folders: dd-sdk-ios `DatadogSessionReplay/Sources` 263, dd-sdk-android session-replay `src/main` 85 (108 with compose), dd-sdk-reactnative session-replay package 96. High. Pin to tags, sync by script with the output seam as the only patch | Higher: every patch touches files that upstream also changes | Lowest of the three: the seam and the obfuscator are the whole diff. Schema or converter fixes ship in the reader, not in an app release |
| **Old SDKs in the field** | A reader fix needs a player release only | A converter bug is frozen into every shipped app | A converter bug is fixed once, for all stored data |

`git log` counts include merge commits and bot commits and were taken over 2025-11-12 to 2026-11-12.

## Recommendation: C

Borrow Datadog's recorders, keep their record format on the wire as `ouo-wireframe/1`, and convert to rrweb events in the reader. This is PostHog's actual model, one rrweb player serves web and mobile, and it keeps the vendored code closest to upstream.

**Why not A:** there is no Datadog player to copy, so A is C's decoder written as a second player.
**Why not B:** it puts the conversion on the device twice, in code nobody can fix once an app ships, and makes every upstream sync harder.

**What would change it:**
- The Grafana plugin cannot decode segments in the browser at an acceptable cost: move the decoder into the read path of `rum-api` (still C, different place).
- The founder wants third-party tools to read mobile replay without a decoder: B.
- Datadog changes its record format incompatibly: pin the tag and keep `ouo-wireframe/1`; a new schema means `ouo-wireframe/2`.
- RN fidelity on a real app proves too poor for text-heavy screens: fall back to `pixel/frames` or `pixel/video` for RN and keep wireframe for native screens.

## Upstream files to vendor (recommended option C)

Counts are measured for whole folders and estimated after trimming (marked). Trimming means leaving out what the first cut does not use.

**iOS, from dd-sdk-ios 3.22.0, `DatadogSessionReplay/Sources/`** (Apache-2.0):
- `Recorder/`: 83 files, 7 450 lines. Take all except `ViewTreeSnapshotProducer/ViewTreeSnapshot/NodeRecorders/SwiftUI/` (16 files, about 1 300 lines, experimental) and the image encoding helpers (`UIImage+Encoding`, `UIImage+ContentHash`, `UIImage+DominantColor`, `UIImage+Redaction`), because images are placeholders in v1. About 63 files, 5 700 lines (estimate).
- `Processor/`: 9 files, 1 574 lines (`SnapshotProcessor`, `Builders/RecordsBuilder`, `Builders/WireframesBuilder`, `Diffing/Diff+SRWireframes`, `Diffing/Diff`, `Flattening/NodesFlattener`, `Privacy/TextObfuscator`); drop `ResourcesProcessor` and `Diffing/Diff+SRCompositionTree`. About 7 files, 1 400 lines.
- `Models/SRDataModels.swift` (3 138 generated lines) trimmed to the used types (`SRWireframe`: shape, text, placeholder, webview; records; mutations; touches), about 600 lines (estimate), and `Models/SRDataModels+UIKit.swift` (55).
- `Utilities/` (6 files, 254 lines).
- Not vendored: `Feature/` (13 files, 1 257 lines: Datadog upload and RUM wiring), `Writers/` (3, 192), `LayerTreeRecorder/` (37, 5 582, experimental). Replace with our writer that turns records into NDJSON chunks.
- Plus `DatadogInternal` pieces the files import (61 import lines): replace with our `Seams.swift`, as PR #181 did for Sentry.
- iOS total: about 80 files and 8 000 lines (estimate), against 163 files and 20 690 lines in the module.

**Android, from dd-sdk-android 3.16.0, `features/dd-sdk-android-session-replay/src/main/`** (Apache-2.0):
- `kotlin/.../recorder/` (mappers: 8 files, 836 lines) and `internal/recorder/` (`SnapshotProducer`, `TreeViewTraversal`, `ViewOnDrawInterceptor`, `WindowsOnDrawListener`, `RecorderWindowCallback`, `SessionReplayRecorder`, `mapper/` 22 files and 2 509 lines, `obfuscator/` 5 files): about 55 files, 6 000 lines (estimate).
- `internal/processor/`: 15 files, 1 319 lines.
- `json/schemas/` (the mobile segment schemas, 32 files) and the generated `MobileSegment` model.
- Not vendored: `internal/net` (7 files, 800), `internal/storage` (7, 199), `internal/async`, `SessionReplayFeature` (538), `internal/resources` and `internal/recorder/resources` (20 files, 1 994: image upload), `internal/embedded` (4, 505).
- Optional later: `dd-sdk-android-session-replay-compose` (35 files, 3 607 lines) and `-material` (8 files, 612).
- Plus a seam for the `com.datadog.android.api` imports (121).
- Android total: about 80 files and 8 500 lines (estimate), against 191 files and 16 326 lines in the module.

**React Native, from dd-sdk-reactnative 3.11.0, `packages/react-native-session-replay/`** (Apache-2.0):
- iOS `ios/Sources/`: `RCTTextViewRecorder.swift`, `RCTTextExtractor.{h,mm}`, `RCTTextPropertiesWrapper.{h,mm}`, `RCTFabricWrapper.{h,mm}`, `SvgViewRecorder.swift`, `DdPrivacyOverrider.swift`, `DdPrivacyViewFabric.{h,mm}`, `DdPrivacyViewPaper.m`: 1 308 lines in all with the rest of `Sources`.
- Android `android/src/` (main, `rnlegacy`, `rn69`, `rn80`, `oldarch`): 42 Kotlin files, 3 043 lines: the mappers, `TextPropertiesResolver`, `ReactNativeSessionReplayExtensionSupport`, `utils/`, `extensions/`, `resources/`, `views/DdPrivacyView.kt`.
- Wire the iOS recorders through the extension points Datadog marks `@_spi(Internal)` (iOS) and `ExtensionSupport` (Android); ours must expose the same seams.
- Not vendored: the JS and metro parts; our own `ouo-mask` and `ouo-unmask` replace `DdPrivacyView`.

## `ouo-wireframe/1`

A segment is newline-delimited JSON, one record per line, each chunk body gzipped on its own so the decompressed bodies of a segment concatenate to a valid payload (RPL-7). The records are Datadog's mobile record shapes at the pinned tag: Meta `{type:4, data:{width, height, href?}}`, Focus `{type:6}`, full snapshot `{type:10, data:{wireframes:[…]}}`, and incremental `{type:11, data:{source, …}}` with source 0 mutations (`adds` with `previousId`, `removes`, `updates`), 2 touches and 4 viewport resize; every record carries `timestamp`. Wireframes are flat, absolutely positioned boxes in points or dp (`x`, `y`, `width`, `height`, optional `clip`): `shape` (fill, border, corner radius), `text` (text, font family and size, colour, alignment), `placeholder` (a masked or unsupported view, label only), and `webview`; there are no image bytes in v1. A segment starts with Meta, Focus and a full snapshot, and a new segment starts on every screen change, on any gap (RPL-8) and at the keyframe interval (RPL-9); the SDK may also force a full snapshot. Masking runs on the device before a record is written: static text becomes `***`, inputs and secure fields `***`, images placeholders, and `ouo-mask` and `ouo-unmask` override per view. `ouo.replay.masked` is true. Readers choose the decoder by `ouo.replay.format` (RPL-24): the `ouo-wireframe/1` decoder rebuilds a position-absolute DOM per wireframe, maps ids to rrweb node ids, emits rrweb Meta and full snapshot events for keyframes and rrweb mutations for diffs, then hands the events to the rrweb player. Changing the vendored tag does not change the format id unless a record shape changes incompatibly.

## Not verified

- No device, no build and no run: everything here is from source.
- No Datadog player in a repository other than `DataDog/browser-sdk` and `rum-events-format` was searched for exhaustively; a closed player in their app is the likely reason none is public.
- Line counts after trimming are estimates until the vendoring script exists.
- The converter size (300 to 500 lines) is an estimate from the type set; PostHog's 2 395 lines cover more input types (stars, toggles, selects).
