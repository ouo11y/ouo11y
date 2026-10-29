# ADR-0016 OpenTelemetry in process: opentelemetry-android on Android, a dependency-free Swift package on iOS

Status: accepted (2026-10-29, roadmap agreed by the founder)

## Context

The browser and React Native SDKs build on the OpenTelemetry JS SDK. The native packages need the same decision before W8 (native iOS) and W9 (Android). The research recommended building on the reference SDK on both platforms ([comparison.md §12 item 9](../../project/kb/mobile-sdk-research/comparison.md#12-what-ouo-should-build-recommendations)), and the roadmap splits that answer by platform ([roadmap.md §2.2](../../project/kb/mobile-sdk-research/roadmap.md#22-where-i-disagree)).

What the two reference SDKs offer is not the same ([landscape-open-source.md](../../project/kb/mobile-sdk-research/landscape-open-source.md), G.5):

- **opentelemetry-android** (Apache-2.0) ships sessions with `session.id`, `session.start` and `session.end`, crash, ANR, slow rendering, network, startup, OTLP/HTTP and disk buffering, all on by default.
- **opentelemetry-swift** has none of the lifecycle, tap, crash or hang instrumentation, and its exporters bring gRPC and SwiftProtobuf.

`sdk/ios` today links nothing but Foundation, UIKit and zlib, which is the answer a customer's app review asks for.

## Decision

- **OTel-native means the wire and the names**: OTLP to the customer's collector, semantic conventions (`session.*`, `app.screen.*`, `app.widget.*`, `device.app.lifecycle`), `ouo.` for the rest. It does not mean the reference SDK in every process. The conformance suite (W2) checks the records, not the library that produced them.
- **Android builds on opentelemetry-android.** The native package and the React Native Android module use its agent for sessions, crash, ANR, jank, OTLP/HTTP and disk buffering, and add what ouo needs on top: replay capture (ADR-0014), the session rules of `docs/specs/session-lifecycle.md` through its session provider (its default keeps sessions in memory only), and the spec's event names. The version is pinned, because most of its modules still publish as `-alpha`.
- **iOS stays a dependency-free Swift package.** It gets its own OTLP/JSON exporter for traces and logs over HTTP with gzip and Basic auth to the collector (ADR-0007), reusing the chunk uploader's transport, retry and credential, and the offline store W3 adds. Span, log and attribute names come from the spec. There is no opentelemetry-swift, no gRPC and no protobuf.
- **Fallback: opentelemetry-swift-core.** If customers need the OTel API surface on iOS (bringing their own instrumentation, or seeing ouo's spans in their tracer provider), ouo ships it as a separate opt-in product that depends on opentelemetry-swift-core, which holds the API and SDK types without the exporters. Datadog and Embrace link that same package. The dependency-free products stay as they are. The core moved back into the main opentelemetry-swift repository on 2026-10-08 (#1220, not tagged yet), so which package to link is checked again when the fallback is needed.

## Consequences

- The Android lane saves months: sessions, crash, ANR and disk buffering are not rewritten. It also inherits the upstream release cadence and alpha APIs, so each bump is a reviewed change with the conformance suite as the gate.
- On iOS, ouo owns a few hundred lines of OTLP/JSON encoding and must follow semconv changes by hand. The spec's attribute list is what keeps that honest.
- The two platforms differ inside the process but send the same records, so the plugin, rum-api and the conformance checks do not care which one sent them.
- React Native keeps the OTel JS SDK for JS-side telemetry. Native halves provide what JS cannot see: crashes, hangs, replay, and on Android the opentelemetry-android signals.
