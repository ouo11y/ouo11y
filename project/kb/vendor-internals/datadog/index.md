# Datadog RUM internals

How Datadog's RUM SDKs work inside, what they put on the wire, how reliable the transport is, and what a future Datadog bridge could read back. This is Step 6 (vendor research), researched 2026-11-10. It goes deeper than Step 4. Step 4 already covers which features exist and their defaults: [datadog-web.md](../../client-sdk-features/vendors/datadog-web.md) and [datadog-mobile.md](../../client-sdk-features/vendors/datadog-mobile.md).

Start with the explainer. Datadog cannot be self-hosted and no account was created. Every claim comes from public source at a pinned tag, public docs, or a local capture (`observed:`).

**Pinned versions**

| Component | Version | Commit |
|---|---|---|
| Browser SDK (`@datadog/browser-rum`, `-logs`) | v7.17.0 | `df6c69bd` |
| iOS (`dd-sdk-ios`) | 3.21.0 | `36ca2cfd` |
| Android (`dd-sdk-android`) | 3.16.0 | `dad23122` |
| React Native (`dd-sdk-reactnative`) | 3.11.0 | `740f7bb5` |
| Event schemas (`rum-events-format`) | master | `a4358681` (2026-11-03) |

| Path | What it is |
|---|---|
| [datadog-explainer.html](datadog-explainer.html) | How does Datadog RUM get from the SDK to the intake, and what does a replay segment look like? A visual explainer with wire diagrams |
| [browser-sdk/architecture-and-config.md](browser-sdk/architecture-and-config.md) | How is the browser SDK built, what does every init option do, and how is sampling decided? |
| [browser-sdk/observed-behaviour.md](browser-sdk/observed-behaviour.md) | What did the browser SDK actually send when we drove a page: views, actions, frustrations, errors, vitals, trace headers? |
| [browser-sdk/reliability-and-footprint.md](browser-sdk/reliability-and-footprint.md) | How big is the browser SDK, when does it flush, what does it retry, and what is lost when the page closes? |
| [mobile-sdks/ios.md](mobile-sdks/ios.md) | How does dd-sdk-ios store, batch and upload, and what did a simulator capture show (including data surviving an app kill)? |
| [mobile-sdks/android.md](mobile-sdks/android.md) | How do the Android SDK's modules, options, disk batches, upload rules and replay recorder work? |
| [mobile-sdks/react-native.md](mobile-sdks/react-native.md) | What does the React Native SDK do in JS and what does it leave to the native SDKs? |
| [mobile-sdks/mobile-replay-wireframes.md](mobile-sdks/mobile-replay-wireframes.md) | What are Datadog's mobile replay wireframes, record by record, and what do they cost? Evidence for the wireframe vs video question |
| [wire-format/intake-and-batching.md](wire-format/intake-and-batching.md) | Which endpoints, URL parameters, headers, compression and size limits does each SDK use? |
| [wire-format/event-schema.md](wire-format/event-schema.md) | What do view, view_update, action, resource, error, long_task, vital, telemetry and log events contain? |
| [wire-format/browser-replay-format.md](wire-format/browser-replay-format.md) | How is a browser replay segment built, and how does Datadog's v7 "Change" format differ from rrweb? |
| [wire-format/fixtures/index.md](wire-format/fixtures/index.md) | Which captured, redacted payloads can tests and other agents reuse? |
| [apis/read-apis.md](apis/read-apis.md) | Which public APIs could a Datadog bridge call (events search, aggregate, replay segments), with auth, pagination and rate limits? |
| [apis/storage-and-retention.md](apis/storage-and-retention.md) | What is publicly known about how long and where Datadog keeps RUM events and replays? |

The capture demo lives in [examples/datadog-capture](../../../../examples/datadog-capture/README.md).
