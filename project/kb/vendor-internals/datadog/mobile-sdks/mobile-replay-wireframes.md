# Mobile Session Replay: the wireframe format

- **Schemas:** `rum-events-format` at commit `a4358681` (2026-11-03). `schema:` = `https://github.com/DataDog/rum-events-format/blob/a435868176db82fc337d7b6771e16b758e188509/schemas/session-replay/`
- **SDKs:** iOS 3.21.0 (observed), Android 3.16.0 (source). Research date 2026-11-10.
- This adds Datadog-specific evidence to the open wireframe-vs-video question in [mobile-replay-format-evidence.md](../../../client-sdk-features/mobile-replay-format-evidence.md). Evidence only, no decision.

## What a wireframe is

Datadog never sends pixels of the screen:
- The SDK walks the native view tree (UIKit `UIView`s, Android `View`s or Compose semantics).
- Each visible element becomes a typed **wireframe**: an absolutely positioned rectangle with style.
- The player redraws the screen as HTML from these rectangles.
- Real images are the only pixel data. They are uploaded separately and deduplicated by hash, and only when image privacy allows it.

## Record envelope

Mobile segments use the same envelope as browser segments, `{records: [...], application, session, view, start, end, records_count, has_full_snapshot, source: ios|android|react-native|flutter|kotlin-multiplatform}` (`schema:mobile/segment-schema.json`).

**Record types** (`schema:mobile/record-schema.json`):

| `type` | Record | Data |
|---|---|---|
| 4 | Meta | `{width, height, href?}` (screen size) |
| 6 | Focus | `{has_focus}` |
| 7 | ViewEnd | — |
| 8 | VisualViewport | — |
| **10** | **Full snapshot** | `{wireframes: Wireframe[], compositionTree?}` (`schema:mobile/full-snapshot-record-schema.json`) |
| **11** | **Incremental snapshot** | `data.source` picks the payload (below) |

**Incremental sources** (`schema:mobile/incremental-data-schema.json`):

| `source` | Payload |
|---|---|
| 0 | Mutation: `{adds: [{previousId?, wireframe}], removes: [{id}], updates: [WireframeUpdate]}` (`schema:mobile/mutation-payload-schema.json`) |
| 2 | Touch: `{positions: [{id, x, y, timestamp}]}` |
| 4 | Viewport resize (rotation) |
| 9 | Pointer interaction (down, up, move) |
| 10 | Composition tree mutation (iOS, experimental) |

**When records are emitted:**
- **Every new RUM view starts with Meta → Focus → Full snapshot.** Later changes in the same view are diffs against the previous wireframe list (`https://github.com/DataDog/dd-sdk-ios/blob/3.21.0/DatadogSessionReplay/Sources/Processor/SnapshotProcessor.swift#L100-L126`).
- Android also takes a full snapshot every 3 s and on rotation ([android.md](android.md)).

Observed on iOS: segment 1 was `[4, 6, 10]`. Later segments were `[11/0]`, `[11/0 ×3]`, and a new `[4, 6, 10]` when the detail screen opened.

## Wireframe types

All types share `id` (stable for the view's lifetime), `x`, `y`, `width`, `height` (in points, already scaled), an optional `clip {top, bottom, left, right}`, and `permanentId` (a stable hash across views) (`schema:mobile/_common-wireframe-schema.json`).

| `type` | Extra fields | Used for |
|---|---|---|
| `shape` | `shapeStyle {backgroundColor #RRGGBBAA, backgroundGradient?, opacity, cornerRadius}`, `border {color, width}` | Backgrounds, containers, buttons, separators |
| `text` | shape fields plus `text`, `textStyle {family, size, color, truncationMode}`, `textPosition {padding, alignment {horizontal, vertical}}` | Labels, buttons, text fields |
| `image` | shape fields plus `resourceId` (hash), `mimeType`, `isEmpty`, or inline `base64` (legacy) | Bitmaps, when image privacy allows them |
| `placeholder` | `label` | Masked images and content the SDK cannot render. Observed label: "Image". |
| `webview` | `slotId`, `isVisible` | WebView area. Its content is recorded by the browser SDK inside the WebView and joined by `slotId`. |
| `embedded-content` | `slotId`, `isVisible` | Newer: embedded native content in a slot |

Every type has a matching `*-wireframe-update` schema with all fields optional, used in mutation `updates`.

**Composition tree** (iOS 3.21, experimental, flag `compositionTreeRecording`):
- An optional tree of `composition-layer`s: id, frame, `children` (refs to wireframes or layers), `modifiers` (opacity, clip, blur, shadow, color matrix, saturate, brightness, mask image), and `compositeOperation`.
- It describes CALayer grouping and effects that flat wireframes cannot express (`schema:mobile/composition-tree-schema.json`, `composition-layer-schema.json`).
- Off by default. Datadog is adding it to raise fidelity for SwiftUI and React Native.

## Observed full snapshot (iOS, default privacy)

From [fixtures/ios/replay-full-snapshot.json](../wire-format/fixtures/ios/replay-full-snapshot.json), trimmed:

```json
{"type":"shape","id":6,"x":0,"y":0,"width":402,"height":874,"shapeStyle":{"backgroundColor":"#FFFFFFFF","opacity":1,"cornerRadius":0}}
{"type":"text","id":9,"x":16,"y":132,"width":370,"height":20,"text":"xxxxx xxxxxxx xxxx xxxx xx xxxxxx xx xxxxxxx",
 "textStyle":{"family":"-apple-system, BlinkMacSystemFont, 'Roboto', sans-serif","size":17,"color":"#000000FF","truncationMode":"tail"}}
{"type":"text","id":11,"x":21,"y":169,"width":360,"height":24,"text":"***"}
{"type":"placeholder","id":13,"x":16,"y":210,"width":370,"height":21,"label":"Image"}
{"type":"shape","id":14,"x":16,"y":243,"width":370,"height":40,"shapeStyle":{"backgroundColor":"#00C3D0FF","cornerRadius":12}}
```

And a later mutation, when the label text changed: `{"source":0,"adds":[],"removes":[],"updates":[{"type":"text","id":9,"text":"xxxxxxx xx xxxxxxxxxx xxxxxxxx xxxxx"}]}`.

## Privacy defaults and masking (observed and source)

| Setting | Default (iOS, Android, RN) | Observed effect on iOS |
|---|---|---|
| `textAndInputPrivacyLevel` | `maskAll` | Every character becomes `x`, spaces kept. Text field value becomes `***`. The typed value "Jane Secret" was never in any payload. |
| `imagePrivacyLevel` | `maskAll` | SF Symbol image became `placeholder` "Image". No image upload request. |
| `touchPrivacyLevel` | `hide` | No touch records (our taps were programmatic anyway) |

- In code, `maskAll` uses a space-preserving `x` obfuscator for static text and a fixed-length `***` obfuscator for inputs (`https://github.com/DataDog/dd-sdk-ios/blob/3.21.0/DatadogSessionReplay/Sources/Recorder/PrivacyLevel.swift#L29-L64`).
- Overrides: `maskSensitiveInputs` / `maskAllInputs` for text, `maskNonBundledOnly` / `maskNone` for images, `show` for touches.
- Per-view overrides use `dd.sessionReplayPrivacyOverrides`.
- Masking happens **on the device, before serialization**. Masked strings never leave the device. Sources: Step 4 and the docs page "Mobile Session Replay privacy options", <https://docs.datadoghq.com/session_replay/mobile/privacy_options/> (accessed 2026-11-10).

## Size and cost

| Source | Number |
|---|---|
| Observed, iOS 3.21.0, one simple UIKit screen plus one push, masked, about 15 s | 8 121 B over 4 requests ≈ **0.56 KB/s (34 KB/min)**. Raw segment JSON 18 338 B, about 2.3× deflate. |
| Observed, browser 7.17.0, small page, `mask-user-input` (for comparison) | ≈ 0.65 KB/s (39 KB/min) |
| Docs, iOS average | ~12 KB/s |
| Docs, Android average | 1.22 KB/s |
| Docs, capture cost | One capture every 64–100 ms; a capture takes about 3 ms on the main thread; processing in the background |
| Docs, binary size | iOS about +200 kB IPA; Android AAR 480 kB |

The docs numbers come from <https://docs.datadoghq.com/session_replay/mobile/app_performance/> (accessed 2026-11-10).

Our tiny screen sat at the low end. The iOS docs average is about 20× higher. Images (once unmasked), lists and animation drive the size, since each mutation re-sends the changed wireframes.

## What wireframes cannot show

From the troubleshooting docs (Step 4 evidence [9]):
- Canvas or custom drawing, maps, video players, system dialogs, advanced text styling, SF Symbols and vector images.
- SwiftUI unless the experimental `.swiftui` flag is on.
- Compose without the extra module.

Each unsupported class becomes a `placeholder` or disappears. Fidelity depends on Datadog writing a mapper per view class. The composition tree is their answer for layer effects.

## For our format decision (evidence only)

- **Privacy:** wireframes mask structurally. Text is replaced before upload and no pixels exist to leak. The "mask by default" behaviour comes for free.
- **Bandwidth:** it depends on content. Tiny for static screens; the docs average on iOS is close to video vendors (see the evidence file).
- **Engineering cost:**
  - One mapper per UI toolkit and component class (UIKit, SwiftUI, Views, Compose, RN, Flutter).
  - A player that renders wireframes.
  - A schema with update variants for every type.
- **Interop:** the record envelope (type 4/6/10/11, `source` values) follows rrweb's numbering only loosely. Mobile full snapshots are type **10**, not rrweb's 2. An rrweb player cannot play Datadog mobile segments without a converter.
