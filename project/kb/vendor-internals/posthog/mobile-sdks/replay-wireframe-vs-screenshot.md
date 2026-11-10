# PostHog mobile replay: wireframe schema, screenshot mode, and the evidence

- **Versions:**
  - posthog-ios 3.94.3
  - posthog-android 3.76.1
  - @posthog/react-native-plugin 2.13.0
  - PostHog server and frontend at commit `d231ab1719020024c6219d10dc7775f6621fd72c`
- **Date:** 2026-11-10. Read from source unless marked as measured.
- **Feeds:** the open question in [mobile-replay-format-evidence.md](../../../client-sdk-features/mobile-replay-format-evidence.md) (wireframe vs screenshot or video). Evidence only, no decision.
- **Source keys:**
  - `ios:` = `https://github.com/PostHog/posthog-ios/blob/3.94.3/`
  - `and:` = `https://github.com/PostHog/posthog-android/blob/android-v3.76.1/`
  - `ph:` = `https://github.com/PostHog/posthog/blob/d231ab1719020024c6219d10dc7775f6621fd72c/`

## 1. One format, two modes

PostHog mobile replay always speaks rrweb event types, with a **mobile node model** instead of DOM nodes. In both modes the payload is a `$snapshot` whose `$snapshot_data` is an array of rrweb-style events, with `$snapshot_source: "mobile"`.

- **Wireframe mode** (the native default): the view tree is walked and each view becomes a typed wireframe node. Positions are absolute: points on iOS, dp on Android.
- **Screenshot mode** (opt-in on native, forced on RN and Flutter): a single wireframe node of `type: "screenshot"` covers the screen and carries a `base64` image data URI. Masked regions are painted before encoding.

**The server stores mobile events as sent.**
- Ingestion inspects wireframes only to classify the recording as `screenshot` (the first visual wireframe has `type = 'screenshot'`) or `wireframe` (any other type). The result goes into `snapshot_mode_v2` on `session_replay_events` (ph:docs/internal/mobile-replay-capture-mode.md).
- The conversion from wireframe to rrweb HTML happens **at playback**, in the shared replay transformer `ph:common/replay-shared/src/mobile/transformer/transformers.ts`. *(inferred: the transformer lives in the player-side shared package, not in the ingestion pipeline)*

The formal JSON Schema is `ph:frontend/src/scenes/session-recordings/mobile-replay/schema/mobile/rr-mobile-schema.json`, 53 KB.

## 2. Event types used

| rrweb type | Mobile use | iOS | Android |
|---|---|---|---|
| 4 Meta | `{width, height, href}`. Points or dp. `href` = screen name (iOS) or window title (Android) | when not yet sent or the size changed (ios:PostHog/Replay/PostHogReplayIntegration.swift L828-837) | (and:…/replay/PostHogReplayIntegration.kt L1328-1346) |
| 2 FullSnapshot | `{wireframes: [root], initialOffset: {top: 0, left: 0}}` | **every changed frame** (L855-873) | first frame; and in screenshot mode every changed scene (L783-800) |
| 3 Incremental, source 0 Mutation | `{source: 0, adds: [{parentId, wireframe}], removes: [{parentId, id}], updates: [{parentId, wireframe}]}`. An update is a remove plus an add of the node | **never** | wireframe mode, diff by id over the flattened tree (L1348-1400, L3178-3229) |
| 3 Incremental, source 2 MouseInteraction | `{id, type: 7 TouchStart \| 9 TouchEnd, x, y, source: 2, pointerType: 2}` | id 0 (L732-757) | pointer id, dp (L963-990) |
| 5 Custom | `{tag: "keyboard", payload: {open, height}}` | — | yes (L835-850) |
| 6 Plugin | `rrweb/network@1` `{requests: [{name, method, responseStatus, timestamp, duration, initiatorType: "fetch", entryType: "resource", transferSize}]}`; `rrweb/console@1` `{level, payload}` | URLSession and OSLog/stdout | OkHttp interceptor, logcat |

- **Unchanged frames are suppressed on iOS.** A hash is taken: the `base64` hash in screenshot mode, or a sorted-key tree hash without `id` in wireframe mode. Equal frames are skipped. After 3 unchanged frames, capture backs off to at most 8 s idle (ios:PostHog/Replay/PostHogReplayIntegration.swift L845-853; ios:PostHog/Replay/PostHogReplayCaptureBackoff.swift L11-16).
- **Throttle:** 1 s by default on both platforms.

## 3. Wireframe node (schema)

### Common fields

From ios:PostHog/Replay/RRWireframe.swift L13-40 and and:posthog/src/main/java/com/posthog/internal/replay/RRWireframe.kt L9-32. Nil and null fields are omitted.

| Field | Type | Notes |
|---|---|---|
| `id` | int | iOS `view.hash`, Android `System.identityHashCode(view)`. Stable while the view lives |
| `x`, `y`, `width`, `height` | int | Absolute, in points (iOS) or dp (Android). The player renders `position: fixed` |
| `type` | string | See the table below. Omitted for a plain container on iOS |
| `inputType` | string | For `type: "input"` |
| `text` | string | `type: "text"`. Masked text is `"*" × length` |
| `label` | string | Checkbox, radio, toggle, placeholder |
| `value` | string or number | Input value (masked), progress value |
| `checked`, `disabled` | bool | |
| `options` | string[] | Select |
| `max` | int | Progress |
| `base64` | string | `data:image/webp;base64,…` for `image` (unmasked only) and `screenshot` |
| `url` | string | `web_view` (schema) |
| `style` | object | See below |
| `childWireframes` | wireframe[] | Tree. Android flattens the tree for diffs and carries `parentId` on the mutation wrapper |

### `type` and `inputType` values

These come from the schema's `wireframe*` definitions and the SDK mappings (iOS L1451-1590, Android L2777-3060).

| type | inputType | iOS view | Android view |
|---|---|---|---|
| `text` | — | UILabel, UITextView | TextView |
| `input` | `text_area` | UITextField | EditText |
| `input` | `text`, `password`, `email`, `number`, `search`, `tel`, `url` | (schema) | (schema) |
| `input` | `button` | UIButton | Button |
| `input` | `select` | UIPickerView | Spinner |
| `input` | `toggle` | UISwitch | Switch |
| `input` | `checkbox` / `radio` | — | CheckBox / RadioButton |
| `input` | `progress` | UIProgressView (`max` 1), UIActivityIndicatorView | ProgressBar (`style.bar`) |
| `radio_group` | — | — | RadioGroup |
| `image` | — | UIImageView | ImageView |
| `web_view` | — | WKWebView | WebView |
| `rectangle`, `div` | — | containers | containers |
| `status_bar`, `navigation_bar` | — | — | system bars |
| `placeholder` | — | (schema; used for unsupported content) | — |
| `screenshot` | — | screenshot mode | screenshot mode, one per window |

### `style` (MobileStyles)

- `color`, `backgroundColor` (`#RRGGBB`)
- `backgroundImage`, `backgroundSize`
- `borderColor`, `borderWidth`, `borderRadius`
- `fontFamily`, `fontSize`
- `horizontalAlign`, `verticalAlign`
- `paddingTop`, `paddingBottom`, `paddingLeft`, `paddingRight`
- Android adds `bar` (`horizontal` or `circular`), `iconLeft` and `iconRight` (and:…/internal/replay/RRStyle.kt).

The Android dim layer uses `rgba(0,0,0,a)`.

### Example: iOS wireframe frame

*(inferred: assembled from the code paths above, not captured)*

```json
[{"type":4,"data":{"width":402,"height":874,"href":"HomeViewController"},"timestamp":1794281369000},
 {"type":2,"timestamp":1794281369000,"data":{"initialOffset":{"top":0,"left":0},"wireframes":[
  {"id":105553116266496,"x":0,"y":0,"width":402,"height":874,"style":{"backgroundColor":"#FFFFFF"},
   "childWireframes":[
    {"id":1055531,"x":16,"y":120,"width":370,"height":24,"type":"text","text":"Welcome",
     "style":{"color":"#000000","fontFamily":".SF UI Text","fontSize":17,"horizontalAlign":"left"}},
    {"id":1055532,"x":16,"y":160,"width":370,"height":44,"type":"input","inputType":"text_area","value":"********","disabled":false},
    {"id":1055533,"x":16,"y":220,"width":51,"height":31,"type":"input","inputType":"toggle","checked":true},
    {"id":1055534,"x":16,"y":270,"width":100,"height":100,"type":"image"}]}]}}]
```

The image above is masked, so it has no `base64`.

### Example: Android incremental update

```json
{"type":3,"timestamp":1794281370000,"data":{"source":0,
 "updates":[{"parentId":789,"wireframe":{"id":123,"x":16,"y":160,"width":328,"height":48,"type":"text","text":"Count: 2","style":{"color":"#000000","fontSize":14}}}],
 "removes":[{"parentId":789,"id":456}]}}
```

### Example: screenshot mode (iOS)

```json
{"type":2,"data":{"initialOffset":{"top":0,"left":0},"wireframes":[
  {"id":105553116266496,"x":0,"y":0,"width":402,"height":874,"type":"screenshot","base64":"data:image/webp;base64,UklGR…"}]},"timestamp":1794281369000}
```

## 4. Screenshot encoding

| | iOS | Android |
|---|---|---|
| Format | WebP via vendored libwebp, quality 0.3. JPEG 0.3 fallback | `Bitmap.compress(WEBP_LOSSY)` on API 30+, quality 30 (configurable, experimental) |
| Resolution | 1 px per point by default (402×874 on an iPhone 17 Pro class device). `screenshotScale` 0.1–1.0 of native | 1 px per dp by default |
| When | On a draw or layout change, throttled to 1 s, skipped if the image hash is unchanged | `NextDrawListener`, throttled to 1 s, whole scene composited |
| Masking | Mask rects painted at native resolution, then resampled. **Fails closed:** if masked rendering fails, the frame is dropped | Mask rects drawn. `FLAG_SECURE` windows become black and their touches are dropped |
| Background | `screenshotModeBackgroundCapture` false | — |

Sources: ios:PostHog/Replay/UIImage+Util.swift L13-29; ios:PostHog/Replay/RRWireframe.swift L83-94; and:posthog-android/src/main/java/com/posthog/android/internal/PostHogAndroidUtils.kt L206-235; Android 413 handling comment in and:…/internal/PostHogQueue.kt L516-530.

## 5. Evidence for the open question

### Size

**Measured proxy, 2026-11-10.** Headless Chrome 157 took screenshots of three local pages at 402×874 CSS px (DPR 1, like iOS 1 px per point) with `Page.captureScreenshot`. These are web pages standing in for app screens; no real app was captured.

| Page | WebP q30 | as base64 | JPEG q30 | PNG | WebP q30 at 3× (native Retina) |
|---|---|---|---|---|---|
| Busy table (`feature-matrix.html`) | 23.0 KB | 30.7 KB | 29.1 KB | 78.6 KB | 76.1 KB |
| Demo form page (`posthog-capture/index.html`) | 17.0 KB | 22.7 KB | 29.0 KB | 49.9 KB | 55.3 KB |
| Mostly text (`index.md` as text) | 6.8 KB | 9.0 KB | 9.1 KB | 18.1 KB | 39.3 KB |

For comparison, the **rrweb FullSnapshot of the same demo page was 5.8 KB JSON and 1.3 KB gzip** (observed in our web capture). A mobile wireframe tree is smaller than a DOM snapshot *(inferred)*.

Reading these numbers:
- A screenshot frame is **~10–20× larger on the wire** than a wireframe frame.
- base64 inside JSON adds 33%, and gzip barely shrinks WebP.
- iOS sends a full screenshot on every changed frame, up to 1 per second. Android in screenshot mode does the same per changed scene.
- So a 1-minute session with constant change is roughly 60 × 20 KB ≈ **1.2 MB in screenshot mode**, against tens of KB in wireframe mode *(inferred, upper bound)*.
- PostHog's blog says ~20 KB per screenshot at JPEG q30 (cited in Step 4 [12]). That matches the proxy.
- The Android 413 workaround ("png images exceed our max. limit in kafka") and the 1 MB decompressed replay limit in capture (see [wire format](../wire-format/endpoints-and-payloads.md#3-limits-and-responses)) are signs that screenshot payloads press against the limits.

### Privacy defaults

- **Both modes:** `maskAllTextInputs` and `maskAllImages` are true, and passwords are always masked.
- **iOS also** sets `maskAllSandboxedViews` true.
- **Wireframe mode:** masked text is replaced character for character (`*`), so string length leaks. Masked images are dropped.
- **Screenshot mode:** relies on finding sensitive views to paint over. Step 4 cites PostHog iOS CHANGELOG fixes for unmasked SwiftUI content, layer shadows and button titles drawn outside bounds. iOS now fails closed: it drops the frame if the mask render fails.
- **Labels:** despite its name, `maskAllTextInputs` masks **all text, labels included**, on both platforms. The doc comment reads "Enable masking of all text and text input fields", and iOS `isLabelSensitive` uses the same switch (ios:PostHog/Replay/PostHogSessionReplayConfig.swift L14-16, PostHogReplayIntegration.swift L1383-1389; and:posthog-android/src/main/java/com/posthog/android/replay/PostHogSessionReplayConfig.kt L16-20). The default mobile replay therefore shows layout without readable text. This differs from web, where `maskAllInputs` masks inputs only.

### Fidelity

**Wireframe:**
- Faithful only for views the mapper knows: UIKit, Android Views, and Compose semantics for masking.
- SwiftUI and Jetpack Compose need screenshot mode per the PostHog docs.
- WebViews, custom drawing, maps and video become placeholders or empty rectangles.
- Fonts are approximated by family and size.

**Screenshot:**
- Pixel-accurate for anything on screen, including SwiftUI, Compose, Flutter and WebViews.
- Loses text searchability and DOM-like inspection.
- Resolution is 1 px per point by default (blurry on Retina).

**RN and Flutter use only screenshot mode.** No wireframe mapper exists for the JS view tree.

### Cost on device

- **Not measured here.** Step 5 measures overhead.
- **Screenshot mode** needs render-to-bitmap plus WebP encoding per frame (libwebp on iOS).
- **Wireframe mode** walks the view hierarchy on the main thread per frame and computes a tree hash.
- PostHog's blog claims wireframe is "much less performance-intensive", with no data (Step 4 [12]).
