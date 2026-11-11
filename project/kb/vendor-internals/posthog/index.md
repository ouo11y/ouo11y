# PostHog internals

How PostHog's web and mobile SDKs capture RUM data, what they put on the wire, how the PostHog server stores it, and which APIs could read it back. This is Step 6 of the post-MVP plan, researched on 2026-11-10. It goes deeper than the Step 4 feature rows in [client-sdk-features/vendors](../../client-sdk-features/vendors/index.md).

- **Versions:**
  - posthog-js 1.447.6
  - posthog-ios 3.94.3
  - posthog-android 3.76.1
  - posthog-react-native 4.85.4 with @posthog/react-native-plugin 2.13.0
  - PostHog server at commit `d231ab17` (2026-11-10)
- **Method:**
  - Web: observed with a local capture server ([examples/posthog-capture](../../../../examples/posthog-capture/README.md)).
  - Mobile, storage and APIs: read from source at the pinned tags.
  - No PostHog Cloud account and no self-hosted PostHog were used.

Start with the explainer.

| Path | What it is |
|---|---|
| [posthog-explainer.html](posthog-explainer.html) | How does data flow from the SDK to ClickHouse and S3, how is replay chunked, and what does mobile replay look like? Diagrams |
| [web-sdk/architecture-and-config.md](web-sdk/architecture-and-config.md) | How is posthog-js built (core plus lazy extensions, remote config, flags), what does every RUM-relevant option default to, and how does replay sampling decide? |
| [web-sdk/observed-capture.md](web-sdk/observed-capture.md) | What did posthog-js actually send in one scripted session, where does that differ from the docs, and how big are the bundles? |
| [mobile-sdks/sdks-ios-android-rn.md](mobile-sdks/sdks-ios-android-rn.md) | How are the iOS, Android and React Native SDKs built, configured and made reliable (file queues, retries, crashes)? |
| [mobile-sdks/replay-wireframe-vs-screenshot.md](mobile-sdks/replay-wireframe-vs-screenshot.md) | What is the mobile wireframe schema, how does screenshot mode encode frames, and what are the size, privacy and fidelity trade-offs? |
| [wire-format/endpoints-and-payloads.md](wire-format/endpoints-and-payloads.md) | Which endpoints, headers, compression and limits apply, what is the JSON of each event type, and how is `$snapshot` chunked? |
| [wire-format/fixtures/](wire-format/fixtures/) | Captured web requests (token redacted), listed in the wire-format entry |
| [reliability/delivery-and-retries.md](reliability/delivery-and-retries.md) | How are events batched, flushed at page hide, retried, held offline and quota-limited, and when is data dropped? |
| [storage/storage-and-ingestion.md](storage/storage-and-ingestion.md) | Which Kafka topics and ClickHouse tables hold events, sessions and replay metadata, how are replay blocks stored in S3, and how do retention and deletion work? |
| [apis/read-apis.md](apis/read-apis.md) | Which read APIs (session recordings, snapshots, HogQL query, persons) could ouo consume, with auth scopes, pagination and rate limits? |
