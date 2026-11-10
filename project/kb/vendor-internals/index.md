# Vendor internals

How Sentry, Datadog and PostHog work inside: SDK architecture and every option, behaviour observed on the wire, reliability, wire formats, backend storage and the read APIs we could consume. Step 6 of the post-MVP plan, researched 2026-11-10. Step 4 ([client-sdk-features](../client-sdk-features/index.md)) says which features each vendor has; this area says how they work. Sentry is the main focus because ouo rides on top of it (Sentry SDK to Sentry with Muninn reading back, Sentry SDK through our collector, or our own SDK).

| Path | What it is |
|---|---|
| [mobile-replay-evidence.md](mobile-replay-evidence.md) | What did Step 6 measure about video, wireframe and screenshot mobile replay (bytes per minute, masking, reliability)? Evidence only, no decision |
| [sentry/](sentry/index.md) | Sentry on browser, iOS, Android and React Native: SDKs, captured envelopes, Relay wire format, self-hosted storage, and the read APIs Muninn can use |
| [datadog/](datadog/index.md) | Datadog RUM SDKs (browser, iOS, Android, React Native), intake format, the v7 browser replay format, mobile wireframe replay, and public read APIs |
| [posthog/](posthog/index.md) | PostHog SDKs (posthog-js, iOS, Android, React Native), capture endpoints, replay chunking, wireframe and screenshot mobile replay, ClickHouse and S3 storage, and read APIs |
