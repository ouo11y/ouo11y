# Platform foundations: what a recorder can read

Explainer: [topic 1](../session-replay-explainer.html#t1). Sources at pinned tags are linked from the explainer and from the source notes in [browser/](../browser/index.md) and [mobile/](../mobile/index.md).

## The one idea

The browser hands any script a live, readable, observable tree (the DOM) that fully describes the page. On mobile there is a tree too, but it is private to the UI framework, it is not the whole truth (custom drawing, SwiftUI, Compose and Flutter hide inside one view), and nothing notifies an outsider when it changes. That difference is why web replay is mostly a tree diff and mobile replay is mostly pictures.

## Per platform

- **Browser.** Nodes and attributes; one event loop runs task → microtasks → requestAnimationFrame → style, layout, paint, composite. `MutationObserver` delivers `childList`, `attributes` and `characterData` records in a microtask after the change, batched.
- **iOS (UIKit).** `UIView` is backed by `CALayer`; Core Animation commits layer changes to the render server, which draws out of process. Two copies matter for replay: the model layer (where the app says a view is) and the presentation layer (where an animation shows it now). SwiftUI renders through private hosting views, so a view walk sees few, opaque nodes.
- **Android (Views).** `Choreographer` drives `ViewRootImpl.performTraversals` (measure, layout, draw). `ViewTreeObserver.OnDrawListener` fires before the frame is recorded; `ThreadedRenderer` records `RenderNode`s and the render thread draws them. `PixelCopy` reads the finished surface asynchronously.
- **Compose.** One `AndroidComposeView` holds an internal `LayoutNode` tree; the public view of it is the semantics tree, which is built for accessibility and does not carry everything drawn.
- **React Native (Fabric).** A C++ `ShadowTree`, committed through the `MountingCoordinator` into native views. View flattening removes layout-only views, and text is drawn inside `RCTParagraphComponentView`'s `drawRect`, so a native walk sees a paragraph view, not its text runs.
- **Flutter.** Widget → Element → RenderObject → Layer; the engine draws into one `FlutterView`, so a native walk sees one opaque view. Inside Dart, post-frame callbacks and `RepaintBoundary.toImage` are the hooks.

## What it means for replay

A recorder on the web can describe the screen exactly and cheaply. A native recorder either reads a partial tree (wireframes, with gaps for custom drawing and SwiftUI) or takes pictures and uses the tree only to find what to mask. Cross-platform frameworks are recorded by native SDKs (React Native) or inside the framework (Flutter).
