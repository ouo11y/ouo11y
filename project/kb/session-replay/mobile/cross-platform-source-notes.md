# Cross-platform session replay internals (React Native and Flutter)

Read-only source study, 2026-11-10/11. Every repo was shallow-cloned at the tag below. All line numbers come from the checked-out files. When a claim was not checked against code, it says **(not read in code)**.

## Repos and pinned refs

| Repo | Ref used | Commit SHA | Role |
|---|---|---|---|
| getsentry/sentry-react-native | `8.34.0` | 0b9d5e94ebeaad1bbdccc743b2ab4777d1e1e719 | RN JS and native bridge |
| getsentry/sentry-cocoa | `9.33.0` | 8cdf0fe8124d9daae8524f15c169c558a84ddacd | iOS replay engine used by RN and Flutter |
| getsentry/sentry-java | `8.63.0` | 19813ee6c4ef0ad8934123d9c54d0e4aeffa842c | Android replay engine used by RN and Flutter |
| getsentry/sentry-dart | `10.3.0` | 0296125c397eef9963730390cef1fb7480355a39 | `packages/flutter` |
| PostHog/posthog-js | `posthog-react-native@4.86.0` (same commit as `@posthog/react-native-plugin@2.13.1`) | ea6035c5fec0d6c275b5e3fde5ddaf5846036e7a | `packages/react-native`, `packages/react-native-plugin` |
| PostHog/posthog-react-native-session-replay | `v1.5.1` | 7d993e8d8a92d1834f0e877abd349d76e4e89587 | legacy plugin, now deprecated (cloned, not studied) |
| PostHog/posthog-ios | `3.94.3` | d237d54a4a411966d99f95e54d7149e0d9ba1932 | iOS replay |
| PostHog/posthog-android | `3.22.0` | ea3a0e14c56575583747560a62d99c9134d78d6b | Android replay |
| PostHog/posthog-flutter | `5.60.1` | d788d2cd6ee4eb3e57dad6adf7e8e856817efb4a | `posthog_flutter/` |
| DataDog/dd-sdk-reactnative | `3.11.0` | 740f7bb57bf494788159bc5b6f7d9fd2673c3879 | `packages/react-native-session-replay` |
| DataDog/dd-sdk-flutter | `datadog_session_replay/v1.0.0-preview.17` (pre-release; no stable tag for this package) | 063586df86e6c435be8a22823d626e11f8f05fa6 | `packages/datadog_session_replay` |
| openreplay/ios-tracker | `1.0.26` | db2a165655e5ce8c6ae7c2bc43a2504666a48a44 | iOS tracker |
| openreplay/android-tracker | `v1.1.17` | bcaf0d38aba157d9f8bddd552090ed53ba39101d | Android tracker |
| openreplay/openreplay | `v1.28.0` | 812d5544c5dc6ae8f9cc95c2c163f79d40c26dfa | `tracker/tracker-reactnative` (0.7.12), `tracker/tracker-flutter` (1.0.9) |
| facebook/react-native | `v0.88.1` (sparse checkout) | c30b7f86850d47422637a64c70508e7411dbd8ea | Fabric foundations |
| flutter/flutter | `3.47.9` (sparse checkout) | c197ca5199e9ee5661e865596c9c07294dfab51c | framework and engine foundations |

Two links use the commit SHA instead of the tag, because their tags contain a `/` that GitHub blob URLs cannot always resolve: dd-sdk-flutter, and posthog-js when the plugin tag is meant. The posthog-js links use the tag `posthog-react-native@4.86.0`, which points at the same commit.

Link prefixes used below:
- SRN = `https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core`
- SC = `https://github.com/getsentry/sentry-cocoa/blob/9.33.0`
- SJ = `https://github.com/getsentry/sentry-java/blob/8.63.0`
- SD = `https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter`
- PJ = `https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages`
- PI = `https://github.com/PostHog/posthog-ios/blob/3.94.3`
- PA = `https://github.com/PostHog/posthog-android/blob/3.22.0`
- PF = `https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter`
- DRN = `https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay`
- DF = `https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay`
- ORI = `https://github.com/openreplay/ios-tracker/blob/1.0.26`
- ORA = `https://github.com/openreplay/android-tracker/blob/v1.1.17`
- OR = `https://github.com/openreplay/openreplay/blob/v1.28.0/tracker`
- RN = `https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native`
- FL = `https://github.com/flutter/flutter/blob/3.47.9`

All links below are written out in full so they can be clicked.

---

## Foundations A: React Native Fabric, from JS component to native view

Replay SDKs never see React components. They see the **native views that Fabric mounts**. The pipeline runs in four steps.

1. **The shadow tree (C++).** Each host component instance becomes an immutable `ShadowNode`. Traits on a node decide whether it becomes a real view: `FormsView` and `FormsStackingContext`.
   - `ShadowNode` class: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h#L31
   - Traits: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/core/ShadowNodeTraits.h#L52-L59
2. **Commit.** `ShadowTree::commit` / `tryCommit` lays out the new root (`layoutIfNeeded`) and pushes the new revision to the `MountingCoordinator`.
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp#L302-L336
   - `layoutIfNeeded`: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp#L417
   - `mountingCoordinator_->push`: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp#L489
3. **Diff into mounting instructions.** `MountingCoordinator::pullTransaction` diffs the base revision against the last revision (`calculateShadowViewMutations`). The result is a list of `Create/Delete/Insert/Remove/Update` mutations.
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/MountingCoordinator.cpp#L71-L94
   - Mutation types: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/ShadowViewMutation.h#L86-L92
   - **View flattening** happens here. Nodes that are not `FormsView` (layout-only `<View>`s) never become native views: https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactCommon/react/renderer/mounting/internal/sliceChildShadowNodeViewPairs.cpp#L109-L125. This is why a JS wrapper `<View>` cannot be relied on to exist natively. OpenReplay works around it with `collapsable={false}` (see Flow 5).
4. **Mount on iOS.** `RCTPerformMountInstructions` dequeues a component view per `Create` mutation (`dequeueComponentViewWithComponentHandle`) and calls `mountChildComponentView` on `Insert`.
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/React/Fabric/Mounting/RCTMountingManager.mm#L43-L102
   - Base class: `RCTViewComponentView : UIView` https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.h#L25
   - `<Text>` becomes `RCTParagraphComponentView : RCTViewComponentView` (https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.h#L17). Its inner `RCTParagraphTextView` **draws the attributed string itself in `drawRect`**; it is not a `UILabel` (https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.mm#L429-L455). This is the root reason every iOS replay SDK must name `RCTParagraphComponentView` explicitly.
   - `<Image>` becomes `RCTImageComponentView`, which wraps an `RCTUIImageViewAnimated` (https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/React/Fabric/Mounting/ComponentViews/Image/RCTImageComponentView.mm#L35-L38).
5. **Mount on Android.** `IntBufferBatchMountItem.execute` decodes an int-buffer of instructions (`INSTRUCTION_CREATE=2`, `INSERT=8`, `UPDATE_PROPS=32`, ...). `SurfaceMountingManager.createViewUnsafe` then calls `viewManager.createView`, and `addViewAt` inserts the view.
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/mounting/mountitems/IntBufferBatchMountItem.kt#L68-L130
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/mounting/mountitems/IntBufferBatchMountItem.kt#L352-L366
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/mounting/SurfaceMountingManager.kt#L578-L612
   - https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/mounting/SurfaceMountingManager.kt#L297
   - On Android, RN text is `ReactTextView` (a `TextView`) and RN images are `ReactImageView` (an `ImageView`, via Fresco). That class hierarchy is why the generic Android `TextView`/`ImageView` masking catches RN content **(hierarchy not read in RN code; inferred from the Datadog and Sentry mappers below that import `com.facebook.react.views.text.ReactTextView` and `...image.ReactImageView`)**.

**Consequence for replay.** On both platforms, an RN replay SDK is a native screen-capture or native view-tree SDK plus three additions: (a) RN class names in the mask lists, (b) a native "privacy container" view that a JS wrapper component renders, and (c) JS-side events (navigation, touches, network) bridged into the native replay's breadcrumb stream.

## Foundations B: Flutter, Widget to Element to RenderObject to Layer to pixels

1. **Widget, Element, RenderObject.**
   - `Widget.createElement()`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/widgets/framework.dart#L312-L349
   - `RenderObjectWidget.createRenderObject`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/widgets/framework.dart#L1893-L1914
   - `Element`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/widgets/framework.dart#L3570
   - `RenderObjectElement.mount` calls `createRenderObject(this)`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/widgets/framework.dart#L6797-L6803
   - Replay maskers walk the **element tree** with `visitChildElements` / `debugVisitOnstageChildren` (https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/widgets/framework.dart#L3928-L3932). From each element they reach `element.renderObject` to get geometry.
2. **The frame pipeline.**
   - `SchedulerBinding.handleBeginFrame`, then `handleDrawFrame`. The latter runs persistent callbacks, which include `drawFrame`, and then **post-frame callbacks**: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L1226 and https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L1338-L1352
   - `addPostFrameCallback`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L818
   - `endOfFrame`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L847
   - `ensureVisualUpdate`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L906
   - `scheduleFrame`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/scheduler/binding.dart#L946
   - A post-frame callback does **not** request a frame. On an idle screen it never fires unless someone calls `scheduleFrame`/`ensureVisualUpdate`. Every Flutter recorder below deals with this.
   - `RendererBinding.drawFrame` runs `flushLayout`, then `flushCompositingBits`, then `flushPaint`, then `compositeFrame` ("sends the bits to the GPU"): https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/binding.dart#L691-L697
   - Implementations in `PipelineOwner`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/object.dart#L1137 (`flushLayout`), https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/object.dart#L1239 (`flushCompositingBits`), https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/object.dart#L1293 (`flushPaint`)
3. **Layers and pictures.**
   - Painting records into `PictureLayer`s: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/layer.dart#L824
   - `dart:ui` `PictureRecorder`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/painting.dart#L8604
   - `Picture.toImage`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/painting.dart#L8436-L8456
   - `Scene`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/compositing.dart#L12-L25
4. **`RenderRepaintBoundary.toImage`.** It asserts `!debugNeedsPaint`, takes its own `OffsetLayer` and calls `OffsetLayer.toImage`. That builds a `ui.Scene` from the layer subtree and calls `scene.toImage`.
   - https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/proxy_box.dart#L3552-L3556
   - https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/layer.dart#L1546-L1557
   - Sync variant `toImageSync`: https://github.com/flutter/flutter/blob/3.47.9/packages/flutter/lib/src/rendering/proxy_box.dart#L3618
5. **Engine.**
   - `Scene::toImage` goes to `Picture::RasterizeLayerTreeToImage`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/compositing/scene.cc#L61-L71
   - This posts to the **raster task runner**, flattens the layer tree into a DisplayList and calls `MakeImpellerSnapshot` (or `MakeSkiaSnapshot` when Impeller is off). The image is handed back on the UI runner: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/painting/picture.cc#L244-L289
   - So a replay "screenshot" in Flutter is a **re-rasterization of the last layer tree on the raster thread**, not a read-back of the on-screen framebuffer. Platform views (native maps, web views) are not in that layer tree, which is why PostHog and OpenReplay mask or bridge them separately.
   - The frame rasterizer is `Rasterizer::Draw` / `DrawToSurfaces`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/shell/common/rasterizer.cc#L246 and https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/shell/common/rasterizer.cc#L615
   - `ImageByteFormat` (rawRgba/png): https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/painting.dart#L1852
   - `Image.toByteData`: https://github.com/flutter/flutter/blob/3.47.9/engine/src/flutter/lib/ui/painting.dart#L2063

---

## Flow 1: Sentry React Native, `mobileReplayIntegration`

**Technique:** JS only configures the integration. Native sentry-cocoa and sentry-android capture masked screenshots at 1 fps and encode them into an MP4 video segment, which is sent as an rrweb `video` custom event.

1. **JS options and defaults.** `MobileReplayOptions` has `maskAllText`, `maskAllImages`, `maskAllVectors`, `enableViewRendererV2`, `maskedViewClasses`/`unmaskedViewClasses` (documented as *native* class names such as `RCTTextView`), `screenshotStrategy` (`pixelCopy`|`canvas`, Android) and `captureSurfaceViews`. All `maskAll*` default to `true`.
   - Options: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L47-L200
   - Defaults: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L305-L328
2. **Factory.** The integration becomes a no-op in Expo Go or on non-mobile platforms. It caches the replay id in JS to avoid bridge calls.
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L366-L414
3. **Options cross the bridge once, at native init.** `ReactNativeClient` passes `mobileReplayOptions` inside `NATIVE.initNativeSdk(...)`. RegExps are serialized to strings first.
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L259-L271
4. **iOS options mapping.**
   - `RNSentryReplay.updateOptions` rewrites the RN dictionary into sentry-cocoa's `sessionReplay` dictionary: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L14-L56
   - `getReplayRNRedactClasses` turns the booleans into **class names**: `RNSVGSvgView` (vectors), `RCTImageView` + `RCTImageComponentView` (images; the comment explains that Fabric's image view is neither a UIImageView subclass nor named RCTImageView), and `RCTTextView` + `RCTParagraphComponentView` (text). User `maskedViewClasses` are appended: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L58-L91
   - Called from start-up: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L64-L77
5. **Android options mapping.** `RNSentryStart.getReplayOptions` builds `SentryReplayOptions`: `maskAllText`/`maskAllImages`, `com.horcrux.svg.SvgView` for vectors, user classes, the screenshot strategy, and finally `setMaskViewContainerClass(RNSentryReplayMask)` / `setUnmaskViewContainerClass(RNSentryReplayUnmask)`.
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L444-L550
   - Breadcrumb converter installed: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L227-L230
6. **Native redaction lists already contain RN classes, even without the RN SDK.**
   - sentry-cocoa `SentryUIRedactBuilder.init` inserts `RCTTextView`, `RCTParagraphComponentView` and `RCTImageView` "to avoid leaking text from RN apps with manually initialized sentry-cocoa": https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Tools/ViewCapture/SentryUIRedactBuilder.swift#L146-L196
   - sentry-java masks by class hierarchy (`isAssignableFrom(options.maskViewClasses)`). The defaults include TextView, ImageView, WebView and video views: https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryReplayOptions.java#L247-L254
   - Decision logic: https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/viewhierarchy/ViewHierarchyNode.kt#L318-L349
   - `fromView` gives `TextView`/`ImageView` special nodes: https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/viewhierarchy/ViewHierarchyNode.kt#L366-L411
   - Android also honours a string view `tag` containing `sentry-mask`/`sentry-unmask` (lines 318-333 of the same file).
7. **`<Mask>` / `<Unmask>` are native host components.** In JS, `Mask` is `NativeComponentRegistry.get('RNSentryReplayMask')`. If the native view manager is missing, it falls back to a plain `View` and prints a warning about PII leaks.
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/CustomMask.tsx#L13-L65
   - iOS: `RNSentryReplayMask` is a `UIView` (Fabric component view with typed default props): https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/Replay/RNSentryReplayMask.mm#L15-L60
   - Android: `RNSentryReplayMask extends ReactViewGroup`: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/replay/RNSentryReplayMask.java#L6-L10
   - Fabric manager: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/newarch/java/io/sentry/react/replay/RNSentryReplayMaskManager.java#L11-L33
8. **How the mask reaches the redactor: the view's class identity, not props.**
   - iOS `postInit` registers the Mask/Unmask *classes* as redact/ignore containers: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L93-L110
   - sentry-cocoa compares `ObjectIdentifier(type(of: view))` against those classes: https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Tools/ViewCapture/SentryUIRedactBuilder.swift#L474-L491
   - While walking layers, a redacted view forces redaction of its subtree (`enforceRedact`): https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Tools/ViewCapture/SentryUIRedactBuilder.swift#L555-L603
   - Android compares `javaClass.name` of the parent against the container class names: https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/viewhierarchy/ViewHierarchyNode.kt#L335-L359
   - Because the Mask wrapper is a real native view (not a layout-only View), Fabric cannot flatten it away.
9. **Error-replay flushing.** `beforeSend` only *tags* the event with the buffered replay id. The native flush (`NATIVE.captureReplay`) runs in `afterSendEvent`, so events dropped by sampling do not orphan a replay.
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L429-L524
   - https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L710-L739
10. **Navigation breadcrumbs.** React Navigation adds a JS breadcrumb `category:'navigation'` with `from`/`to`; JS breadcrumbs are forwarded to the native scope (`RNSentry.addBreadcrumb`). The native replay then converts scope breadcrumbs into rrweb breadcrumb events with RN-specific converters. These keep the JS `navigation` crumbs, map `touch` to `ui.tap` with a component-path message, and **drop native navigation crumbs and native `http` crumbs** to avoid duplicates. An oddity: on iOS the `xhr` category is routed to a method named `convertNavigation`.
    - JS breadcrumb: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnavigation.ts#L838-L846
    - Forwarding to native: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L603-L611
    - iOS converter: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplayBreadcrumbConverter.m#L19-L64
    - Android converter: https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryReplayBreadcrumbConverter.java#L32-L64
11. **Frame rate.** 1 fps on both native SDKs.
    - iOS: https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L42
    - Android: https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryReplayOptions.java#L135
    - The MP4 encoding path itself (SentryReplayVideoMaker / Android MediaCodec encoder) was **not read in code** in this pass.

**Example payload (fixture):** the rrweb video event, from https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/test/resources/json/rrweb_video_event.json#L1-L21

```json
{ "type": 5, "timestamp": 12345678901,
  "data": { "tag": "video",
    "payload": { "segmentId": 0, "size": 4000000, "duration": 5000,
      "encoding": "h264", "container": "mp4", "height": 1920, "width": 1080,
      "frameCount": 5, "frameRate": 1, "frameRateType": "constant",
      "left": 100, "top": 100 } } }
```

---

## Flow 2: Sentry Flutter replay

**Technique:** Dart captures the image itself with `RenderRepaintBoundary.toImage`, masks it in Dart, and hands **raw RGBA** to the native SDK. The native SDK encodes the video (sentry-cocoa on iOS, sentry-java on Android). Masking is decided in Dart against **Widget types** found in the element tree. The control direction **differs per platform**.

1. **Root boundary.** `SentryScreenshotWidget` wraps the app in a `RepaintBoundary` keyed by the global `sentryScreenshotWidgetGlobalKey`.
   - Key: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/sentry_screenshot_widget.dart#L7-L8
   - Boundary: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/sentry_screenshot_widget.dart#L134
2. **Size/config.** On each `onBuild` of that widget, the integration sends a `ReplayConfig` to native (window size times the quality scaling factor). The default `frameRate = 1`.
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/replay_integration.dart#L47-L70
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/replay_config.dart#L23
3. **The capture itself** (`ScreenshotRecorder.capture`, documented as "THIS FUNCTION MUST NOT BE ASYNC"). It finds the boundary, calls `renderObject.toImage(pixelRatio)` and **synchronously in the same task** runs the widget filter, so mask rects match the pixels. Then, in an async task, it calls `image.toByteData()` (a workaround for mangled images), draws the image plus opaque mask rects onto a new `PictureRecorder` canvas, and calls `picture.toImage(w,h)`.
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/recorder.dart#L57-L131
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/recorder.dart#L140-L144
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/recorder.dart#L227-L317
4. **Masking rules are Widget-type based.** User rules come first, then `SentryMask`/`SentryUnmask`, then `Image` (assets exempt by default), then `Text`, `EditableText`, `RichText`, then `SensitiveContent`. In debug builds there is a regex warning for widget type names matching `video|webview|password|pinput|camera|chart`.
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/sentry_privacy_options.dart#L31-L133
5. **Tree walk.** `WidgetFilter.obscure` does a breadth-first walk over `visitChildElements` / `debugVisitOnstageChildren`. It skips `Visibility(false)`, `Opacity(0)` and `Offstage`. A masked element's `RenderBox.paintBounds` is transformed to the root (`getTransformTo`) and clipped by `RenderStack` clips. The mask colour is taken from the text style, or from `RenderParagraph.text.style`, falling back to the theme.
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/widget_filter.dart#L26-L89
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/widget_filter.dart#L123-L201
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/widget_filter.dart#L222-L226
6. **Scheduling.** `Scheduler` is a *delay-after-completion* loop, not `Timer.periodic`. After each run it waits `interval` (1000/frameRate ms), then `addPostFrameCallback(_run)`. `ScheduledScreenshotRecorder._addPostFrameCallback` calls `ensureVisualUpdate()` first, so a frame is forced even on an idle screen. It skips capture when the lifecycle is not `resumed` (Vulkan teardown crash #3923).
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/scheduler.dart#L7-L89
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/scheduled_recorder.dart#L38-L42
   - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/scheduled_recorder.dart#L88-L136
7. **Unchanged frames are not deduplicated in Dart.** The `_IdleFrameFiller` is commented out with "we've decided to capture on every frame": https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/replay/scheduled_recorder.dart#L191-L256. `Screenshot.hasSameImageAs` exists but has no caller in `lib/`: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/screen_capture/screenshot.dart#L49-L55. Redundancy is left to the video codec.
8. **Android: Dart pushes frames.**
   - The native `ReplayIntegration` is built with a `SentryFlutterReplayRecorder` as its `Recorder`. Its `start/pause/onConfigurationChanged` only call back into Dart; native never takes a screenshot:
     - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/android/src/main/kotlin/io/sentry/flutter/SentryFlutterPlugin.kt#L289-L299
     - https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/android/src/main/kotlin/io/sentry/flutter/SentryFlutterReplayRecorder.kt#L12-L54
   - Dart rounds the size to the 16-pixel codec block and sends `ScreenshotRecorderConfig` over JNI: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/native/java/sentry_native_java.dart#L313-L373
   - `AndroidReplayRecorder` sends raw RGBA as `TransferableTypedData` to a worker isolate: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/native/java/android_replay_recorder.dart#L71-L106
   - The worker copies it into a reused `Bitmap` (`copyPixelsFromBuffer`) and calls `ReplayIntegration.onScreenshotRecorded(bitmap)` (timestamp TODO noted): https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/native/java/android_replay_recorder.dart#L143-L181
9. **iOS: native pulls frames.**
   - The plugin configures sentry-cocoa's hybrid replay with a `SentryFlutterReplayScreenshotProvider`: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/darwin/sentry_flutter/Sources/sentry_flutter/SentryFlutterPlugin.swift#L396-L406
   - On each native capture tick, its `imageWithView:` invokes the method channel `captureReplayScreenshot`: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/darwin/sentry_flutter/Sources/sentry_flutter_objc/SentryFlutterReplayScreenshotProvider.m#L24-L41
   - Dart answers with a malloc'd pointer `{address,length,width,height}`: https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/native/cocoa/sentry_native_cocoa.dart#L26-L56 and https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/lib/src/native/cocoa/cocoa_replay_recorder.dart#L17-L39
   - Native wraps it with `dataWithBytesNoCopy:freeWhenDone:` into a `CGImage`/`UIImage` (premultiplied RGBA): https://github.com/getsentry/sentry-dart/blob/10.3.0/packages/flutter/darwin/sentry_flutter/Sources/sentry_flutter_objc/SentryFlutterReplayScreenshotProvider.m#L46-L89
   - The iOS cadence is therefore sentry-cocoa's scheduler at 1 fps (cocoa scheduler internals **not read in code**).
10. **Payload:** identical to Flow 1 (rrweb `video` event, mp4/h264), produced by the native SDK.

---

## Flow 3: PostHog React Native and PostHog Flutter

### 3a. PostHog React Native, a JS shell over native posthog-ios/android in screenshot mode

1. **Where the code lives now.** `posthog-react-native` is in the **PostHog/posthog-js** monorepo (`packages/react-native`). Replay goes through the optional native package **`@posthog/react-native-plugin`** (same monorepo). The older `posthog-react-native-session-replay` repo is a deprecated fallback.
   - https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages/react-native/src/optional/OptionalPlugin.ts#L42-L87
2. **JS builds `sdkReplayConfig`** (`maskAllTextInputs`, `maskAllImages`, `throttleDelayMs`, ...) and calls `OptionalReactNativePlugin.setup(sessionId, sdkOptions, pluginConfig)`.
   - https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages/react-native/src/posthog-rn.ts#L3318-L3338
   - https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages/react-native/src/posthog-rn.ts#L3393-L3435
3. **The plugin forces screenshot mode.**
   - iOS: `config.sessionReplayConfig.screenshotMode = true`. `throttleDelay` defaults to 1000 ms, and `maskAllTextInputs`/`maskAllImages`/`maskAllSandboxedViews` default to true: https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages/react-native-plugin/ios/PosthogReactNativePlugin.swift#L405-L445
   - Android: `sessionReplayConfig.screenshot = true`, `throttleDelayMs`, masking flags, then `PostHogAndroid.setup`: https://github.com/PostHog/posthog-js/blob/posthog-react-native@4.86.0/packages/react-native-plugin/android/src/main/java/com/posthogreactnativeplugin/PosthogReactNativePluginModule.kt#L189-L214
   - So RN never uses PostHog's wireframe mode.
4. **RN classes in posthog-ios.** `RCTTextView`, `RCTParagraphComponentView`, `RCTImageView`, `RCTImageComponentView` and `RNSVG*` are resolved with `NSClassFromString`: https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L152-L161
   - In `findMaskableWidgets`, **RN text views are masked whenever `maskAllTextInputs` is on**, so the "inputs" flag masks all RN static text too: https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L967-L1003
5. **How JS marks a view.** There is no native mask component. The marker is the string token `ph-no-capture` (or `ph-no-mask`) inside a view's `accessibilityIdentifier` or `accessibilityLabel` on iOS, or its `tag`/`contentDescription` on Android. It reads `super.accessibilityLabel` to avoid RN's slow recursive label.
   - iOS: https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/UIView+Util.swift#L76-L104
   - Android: https://github.com/PostHog/posthog-android/blob/3.22.0/posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt#L1424-L1427
   - That RN maps `testID` to `accessibilityIdentifier` (iOS) and `accessibilityLabel` to `contentDescription` (Android) is **not read in code**.
6. **Capture cadence on iOS.** A run-loop "opportunity" publisher is throttled at `throttleDelay` with `trailing: true`, so an idle screen still gets frames. A structural-fingerprint backoff decides whether to capture.
   - https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L2201-L2213
   - Screenshot path: https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L1702-L1735
   - Mode label (`"screenshot"` vs `"wireframe"`): https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L1901

### 3b. PostHog Flutter, a Dart screenshot sent over a method channel and wrapped by native as a `screenshot` wireframe

1. **Root.** `PostHogWidget` wraps the app in `RepaintBoundary(key: PostHogMaskController.instance.containerKey)`: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/posthog_widget.dart#L356-L357
2. **Trigger.** `ChangeDetector` runs a `Timer.periodic(throttleDelay)`. Each tick registers one `addPostFrameCallback` and calls `scheduleFrame()` only when forced (session start, platform views). An idle screen with no forced tick therefore captures nothing new.
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/change_detector.dart#L43-L71
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/change_detector.dart#L108-L122
   - Wired up with `interval: config.sessionReplayConfig.throttleDelay`: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/posthog_widget.dart#L214-L217
3. **Capture.** It awaits `SchedulerBinding.instance.endOfFrame`, then walks for mask rects **with no await before `toImage()`** (same-frame guarantee, fail-closed if the walk fails), then calls `renderObject.toImage(pixelRatio)` and reads `rawRgba`.
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/screenshot/screenshot_capturer.dart#L700-L757
4. **Unchanged frames.** A 32-bit FNV hash of the raw RGBA *before* masking is compared with the last delivered hash, and the frame is dropped with "nothing changed". A second hash over the final PNG gives a second dedup.
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/screenshot/screenshot_capturer.dart#L495-L524
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/screenshot/screenshot_capturer.dart#L779-L816
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/screenshot/screenshot_capturer.dart#L896-L914
5. **Masking keys on RenderObject types.** This differs from Sentry. The parsers are registered for `RenderImage`, `RenderParagraph`, `RenderTransform`, `RenderEditable` and (optionally) `RenderCustomPaint`.
   - https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/element_parsers/element_parsers_const.dart#L10-L22
   - The element walk (`debugVisitOnstageChildren`) checks `PostHogMaskWidget`/`PostHogUnmaskWidget` and the `Text` widget, then `element.renderObject is RenderImage/RenderCustomPaint`. A zero-sized CustomPaint throws, and the frame is dropped: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/element_parsers/element_object_parser.dart#L19-L110 and https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/mask/widget_elements_decipher.dart#L36-L59
6. **Hand-off to native.** The bytes go over `MethodChannel('posthog_flutter').invokeMethod('sendFullSnapshot', {imageBytes,id,x,y,...})`: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/lib/src/replay/native_communicator.dart#L10-L29
   - iOS builds a `type:"screenshot"` wireframe with `base64`, wraps it in an rrweb FullSnapshot (`type: 2`) and captures `$snapshot`: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/darwin/posthog_flutter/Sources/posthog_flutter/PosthogFlutterPlugin.swift#L1218-L1270
   - Android `SnapshotSender` decodes the PNG into a Bitmap and re-encodes it as **WEBP quality 30** base64: https://github.com/PostHog/posthog-flutter/blob/5.60.1/posthog_flutter/android/src/main/kotlin/com/posthog/flutter/SnapshotSender.kt#L19-L76 and https://github.com/PostHog/posthog-android/blob/3.22.0/posthog-android/src/main/java/com/posthog/android/internal/PostHogAndroidUtils.kt#L237-L250
7. **Native does not capture on Flutter.** posthog-ios skips its own scheduler when the SDK name is `posthog-flutter`:
   - https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L174-L177
   - https://github.com/PostHog/posthog-ios/blob/3.94.3/PostHog/Replay/PostHogReplayIntegration.swift#L329-L330
   - Screenshot only: there are no wireframes from the Flutter render tree.

**Example payload (shape built in code; no JSON fixture found in tests).** From PosthogFlutterPlugin.swift L1252-L1269 and https://github.com/PostHog/posthog-android/blob/3.22.0/posthog/src/main/java/com/posthog/internal/replay/RRFullSnapshotEvent.kt#L6-L23:

```json
{ "event": "$snapshot", "properties": { "$snapshot_source": "mobile",
  "$snapshot_data": [ { "type": 2, "timestamp": 1731300000000,
    "data": { "initialOffset": {"top":0,"left":0},
      "wireframes": [ { "id": 1, "x": 0, "y": 0, "width": 390, "height": 844,
        "type": "screenshot", "base64": "data:image/webp;base64,...", "style": {} } ] } } ] } }
```
(The `data:` prefix and the exact base64 format string were **not read in code**.)

---

## Flow 4: Datadog React Native and Datadog Flutter, wireframes rather than pixels

### 4a. Datadog React Native: custom native mappers for RN views

1. **Android mapper registration.** The SR feature is configured with `addExtensionSupport(ReactNativeSessionReplayExtensionSupport)`, which maps `ReactImageView`, `ReactViewGroup`, `ReactTextView`, `ReactEditText`, `ReactModalHostView` and `DdPrivacyView` (SVG) to custom mappers.
   - https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/ReactNativeSessionReplayExtensionSupport.kt#L36-L45
   - https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/DdSessionReplayImplementation.kt#L52-L58
2. **Android text.** `ReactTextMapper` reuses the stock `TextViewMapper`, then enriches the result with RN properties and drops image/placeholder wireframes: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/mappers/ReactTextMapper.kt#L21-L46
   - On Fabric, text colour comes **via reflection** on a private field (`getDeclaredField(SPANNED_FIELD_NAME)`) to read `ForegroundColorSpan`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/utils/text/FabricTextViewUtils.kt#L33-L62
   - The utils variant is chosen by `IS_NEW_ARCHITECTURE_ENABLED`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/utils/text/TextViewUtils.kt#L155-L160
3. **iOS text.** `RCTTextViewRecorder` (an additional `SessionReplayNodeRecorder`) emits a text wireframe and sets `subtreeStrategy: .ignore`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/RCTTextViewRecorder.swift#L31-L60
   - **Fabric:** it reads the C++ `ParagraphProps` from `RCTParagraphComponentView.props` (`textAttributes`: alignment, colour, font size) plus `view.attributedText.string`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/RCTFabricWrapper.mm#L28-L69
   - **Old architecture:** it hops to the `RCTUIManager` method queue to read the `RCTTextShadowView` (text, attributes, layout) with a 200 ms semaphore timeout, to avoid main-thread/UIManager deadlock: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/RCTTextExtractor.mm#L24-L70
   - Recorder registration, including SVGs from a bundled `assets.json`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/DdSessionReplayImplementation.swift#L28-L57
4. **How JS privacy props reach native.** `<PrivacyView>` (and `MaskAllView`/`MaskNoneView`/`HideView`) renders the codegen component `DdPrivacyView` with string props `textAndInputPrivacy`, `imagePrivacy`, `touchPrivacy`, `hide`, `nativeID`.
   - https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/src/specs/DdPrivacyViewNativeComponent.ts#L17-L28
   - https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/src/components/SessionReplayView/PrivacyView.tsx#L57-L78
   - Android: `@ReactProp` setters write **view tags** (`R.id.datadog_text_and_input_privacy`, `datadog_image_privacy`, `datadog_hidden`, ...), which the native SR reads as overrides: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/views/DdPrivacyView.kt#L16-L50
   - iOS Fabric: `updateProps` calls `DdPrivacyOverrider.setOverrides`, which writes `objc_SessionReplayPrivacyOverrides(view:)` (per-view overrides on the UIView) and sets `accessibilityIdentifier = nativeID`: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/DdPrivacyViewFabric.mm#L51-L70 and https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/ios/Sources/DdPrivacyOverrider.swift#L5-L34
5. **SVG.** A Metro plugin (`withSessionReplayAssetBundler`) collects `.svg` files at bundle time and merges them into an assets file, so the native recorder can emit SVG resources by hash instead of rasterizing: https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/packages/react-native-session-replay/src/metro/index.ts#L20-L80. The babel side that attaches `attributes.hash` was **not read in code**.

### 4b. Datadog Flutter: wireframes built entirely in Dart from the Element tree

1. **Roots.** Each `SessionReplayCapture` widget registers its `Element` with the recorder in `createElement()`: https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/widgets.dart#L13-L35
2. **Trigger.** `Timer.periodic(100 ms)` captures **only if** a post-frame callback has set `_newFrameBuilt`. The comment explains that capturing from the timer instead of inside the post-frame callback keeps the capture out of the build phase. No frame is ever forced, so idle means no capture. The capture shuts down after more than 10 errors.
   - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/datadog_session_replay.dart#L21
   - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/datadog_session_replay.dart#L150-L162
   - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/datadog_session_replay.dart#L180-L233
3. **Walk.** `_captureElement` recurses with `visitChildElements`. It skips invisible subtrees (`Visibility`, `SliverVisibility`, `FadeTransition` with opacity 0) and zero-size `paintBounds`. It picks the first `ElementRecorder` whose `accepts(widget)` matches, transforms `renderObject.paintBounds` into root coordinates and lets the recorder return semantics with a subtree strategy (record or ignore) and possibly tighter privacy for the subtree.
   - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/recorder.dart#L241-L327
   - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/recorder.dart#L339-L446
   - Recorder list (Container, Text, EditableText, InputDecorator, Image, CustomPaint, Privacy, Material and Cupertino checkbox/radio/switch/slider): https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/recorder.dart#L194-L214
4. **Matching is on Widgets, not RenderObjects.** Text accepts `RichText` and reads `TextSpan` text and style. Masking replaces characters while preserving spaces (`maskTextPreservingSpaces`): https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/element_recorders/text_recorder.dart#L21-L100
   - Images accept `RawImage`/`Image`. Asset images may loosen to `maskNone`. A masked image becomes a `PlaceholderNode("Image")`. A captured image reads `ui.Image.toByteData(rawRgba)` and hands it to native `saveImageForProcessing`, and the wireframe references a `resourceId`:
     - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/element_recorders/image_recorder.dart#L75-L131
     - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/element_recorders/image_recorder.dart#L238-L262
     - https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/capture/element_recorders/image_recorder.dart#L398-L425
5. **Diff in a background isolate, then native for transport.** `SessionReplayProcessor` spawns an `Isolate` (https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/processor/processor.dart#L97-L136). `ProcessorWorker` emits Meta + Focus + FullSnapshot when the app, session or view changes, and an incremental diff otherwise. It then `jsonEncode`s an `SREnrichedRecord` and calls `writeSegment(json, viewId)` on the native side (https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/lib/src/processor/processor_worker.dart#L40-L120). Unchanged frames therefore become an empty diff and no record.

**Example payload (fixture):** from the Datadog Flutter Android `SegmentParserTest`, https://github.com/DataDog/dd-sdk-flutter/blob/063586df86e6c435be8a22823d626e11f8f05fa6/packages/datadog_session_replay/android/src/test/kotlin/com/datadoghq/flutter/sessionreplay/embedded/SegmentParserTest.kt#L88-L95

```json
{ "records": [{ "data": {"wireframes": [{"id": 7, "text": "hi", "visible": true}]} }],
  "viewID": "view-id" }
```

---

## Flow 5: OpenReplay mobile, and other open-source efforts

**Technique (all four trackers):** periodic **JPEG screenshots** with opt-in masking of registered views (blur or solid box). Frames are batched into gzip archives that are uploaded separately from the message stream. There are no wireframes and no video.

1. **iOS tracker.**
   - The server `/start` response gives `fps` and `quality`. `captureRate = 1/fps` (clamped 1..99), and the JPEG quality is 0.4/0.5/0.6: https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ORTracker.swift#L99-L106 and https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ORTracker.swift#L267-L284
   - `takeScreenshot` drops a frame if the encoder is backlogged. It calls `window.drawHierarchy(afterScreenUpdates:false)` on main, snapshots the mask frames on main, then composites masks and JPEG-encodes off main: https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ScreenCapture/ScreenCapture.swift#L140-L190
   - Masking is **opt-in only**: `addIgnoredView`, a SwiftUI `.sensitive()` modifier, or `SensitiveTextField`. A weak hash table holds the registered views: https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ORTracker.swift#L172-L174 and https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ScreenCapture/ScreenCapture.swift#L410-L435
   - Archive formats: either "frames" (gzip of `[uint64 LE ts][uint32 LE size][jpeg]...`) or legacy `.tar.gz` of `<ts>.jpeg` files: https://github.com/openreplay/ios-tracker/blob/1.0.26/Sources/OpenReplay/ScreenCapture/ScreenCapture.swift#L318-L366
2. **Android tracker.**
   - A coroutine loop with `delay(screenshotFrequency.millis / fps)`, where Low/Standard/High = 1000/500/300 ms: https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/managers/ScreenshotManager.kt#L131-L151 and https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/models/OROptions.kt#L3-L5
   - Capture uses `PixelCopy` with a Canvas fallback: https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/managers/ScreenshotManager.kt#L657-L766
   - Masks are drawn over registered views: https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/managers/ScreenshotManager.kt#L405-L445
   - Always JPEG ("WEBP_LOSSLESS ignored quality"): https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/managers/ScreenshotManager.kt#L599-L633
   - Frames archive writer: https://github.com/openreplay/android-tracker/blob/v1.1.17/tracker/src/main/java/com/openreplay/tracker/managers/ScreenshotManager.kt#L342-L352
3. **React Native tracker** (`@openreplay/react-native` 0.7.12, inside the openreplay monorepo).
   - It wraps the native trackers but **pins older versions** than the latest tags: iOS `Openreplay 1.0.25` and Android `v1.1.14`.
     - https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-reactnative/openreplay-react-native.podspec#L18
     - https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-reactnative/android/build.gradle#L111
   - `ORSanitizedView` renders a **childless native marker as an absolutely positioned sibling** inside a `collapsable={false}` View, instead of wrapping its children. The comment explains that the paper ViewManager runs through Fabric's interop layer, which re-parents nested interop views at wrong offsets, and that Fabric flattens layout-only Views: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-reactnative/src/index.tsx#L128-L172
   - The marker registers itself in `didMoveToWindow` and returns `nil` from `hitTest`: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-reactnative/ios/ReactNativeORSanitizedViewManager.swift#L16-L37
   - Android uses `onAttachedToWindow`: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-reactnative/android/src/main/java/com/openreplay/reactnative/RntrackerSanitizedViewManager.kt#L25-L38
4. **Flutter tracker** (`openreplay` 1.0.9).
   - Capture follows repaints: `addPostFrameCallback` re-registers itself in `finally`, plus a 10 s heartbeat timer. It is throttled by `captureRate` (default 333 ms) and skipped when `debugNeedsPaint`: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/capture/screenshot_manager.dart#L26-L60, https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/capture/screenshot_manager.dart#L76-L84 and https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/capture/screenshot_manager.dart#L136-L150
   - It uses `boundary.toImageSync()`, masks in Dart (blur), takes `rawRgba` and sends it to native `encodeFrame`: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/capture/screenshot_manager.dart#L152-L224 and https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/native.dart#L28-L50
   - Native computes a 64-bit FNV hash and returns `bytes: nil` when it equals `previousHash` (an unchanged frame is skipped); otherwise it encodes JPEG: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/ios/openreplay/Sources/openreplay/OpenreplayPlugin.swift#L58-L104
   - Masking is opt-in via `ORSanitizedView`, a `RenderProxyBox` that registers in `attach(PipelineOwner)`: https://github.com/openreplay/openreplay/blob/v1.28.0/tracker/tracker-flutter/openreplay/lib/src/capture/sanitized.dart#L11-L30

**Example payload (format built in code; no fixture):** the frames archive body before gzip, from ScreenCapture.swift L331-L345:
```
[uint64 LE timestamp_ms][uint32 LE jpeg_len][jpeg bytes] [uint64 LE ...][uint32 LE ...][...] ...
uploaded as "<sessionId>-<lastTs>.gz"
```

5. **Other open-source React Native options (none read in code).**
   - No rrweb-based React Native recorder was found. rrweb records DOM mutations and does not apply to native views.
   - Mixpanel `mixpanel-react-native-session-replay` (https://github.com/mixpanel/mixpanel-react-native-session-replay) bridges to Mixpanel's native SDKs.
   - NativeReplay (https://github.com/TenitX/NativeReplay) is MIT-licensed but needs a hosted API key.
   - LogRocket React Native is **closed source** (not read in code).
   - Sources: https://github.com/mixpanel/mixpanel-react-native-session-replay, https://github.com/TenitX/NativeReplay, https://blog.openreplay.com/session-replay-for-react-native/

---

## Cross-cutting comparison

| | Capture source | Output | Who drives the clock | Mask decision key | Unchanged-frame handling |
|---|---|---|---|---|---|
| Sentry RN | native screenshot (iOS layer render, Android PixelCopy/Canvas) | MP4 video segments | native, 1 fps | native class names (+ RN class list) and Mask/Unmask container **class** | codec |
| Sentry Flutter | Dart `RenderRepaintBoundary.toImage` | raw RGBA, then native MP4 | iOS: native pulls via method channel; Android: Dart pushes via JNI | **Widget** types (Text, EditableText, RichText, Image) | none in Dart (filler commented out) |
| PostHog RN | native screenshot (forced `screenshotMode`) | rrweb FullSnapshot with `screenshot` wireframe | native throttled run-loop (1 s) | RN class names plus `ph-no-capture` in accessibility id/label or tag | native backoff fingerprint |
| PostHog Flutter | Dart `toImage` | PNG over method channel, then native base64 (WEBP on Android) | Dart Timer plus post-frame callback | **RenderObject** types (RenderParagraph, RenderImage, RenderEditable...) | FNV hash of RGBA plus of the final PNG |
| Datadog RN | native view-tree mappers | JSON wireframes | native SR | per-view privacy overrides (Android tags / iOS overrides object) | native diff |
| Datadog Flutter | Dart Element walk | JSON wireframes, diffed in an isolate | 100 ms Timer gated by a post-frame flag | **Widget** types (RichText, RawImage, ...) | incremental diff |
| OpenReplay (all) | native `drawHierarchy`/PixelCopy, or Flutter `toImageSync` | gzip of JPEGs | native timer / Flutter post-frame | opt-in registered views only | Flutter: native FNV hash; iOS/Android: none seen |
