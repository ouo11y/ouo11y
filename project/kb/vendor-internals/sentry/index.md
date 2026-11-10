# Sentry internals

How Sentry works from the SDK call to the API response, on browser, iOS, Android and React Native, researched 2026-11-10 (Step 6). Sentry is the main focus because ouo rides on top of it: (a) Sentry SDK to Sentry, with Muninn reading back through the API; (b) Sentry SDK to our collector, which fans out to Sentry and to us; (c) our own SDK. Captures come from the demos [examples/sentry-web](../../../../examples/sentry-web/README.md) and [examples/sentry-mobile](../../../../examples/sentry-mobile/README.md), sent through `collector/tools/sentrytap` to a local self-hosted Sentry 26.10.0. Start with the explainer.

Versions: `@sentry/browser` and `@sentry/react` 11.11.0, sentry-cocoa 9.33.0, sentry-java 8.63.0, `@sentry/react-native` 8.34.0, self-hosted Sentry, Relay and Snuba 26.10.0.

| Path | What it is |
|---|---|
| [sentry-explainer.html](sentry-explainer.html) | How does one piece of data travel from each SDK through Relay, Kafka and the stores to the API, and what does that mean for each ouo topology? |
| [browser-sdk/](browser-sdk/index.md) | Browser SDK: architecture, every option, sampling, reliability, replay internals, captured envelopes, bundle sizes |
| [mobile-sdks/](mobile-sdks/index.md) | iOS, Android and React Native SDKs: architecture, every option, reliability, video replay, captured envelopes |
| [wire-format/](wire-format/index.md) | Envelope framing, every Relay item type, replay on the wire, OTLP ingest, limits and rate limits, and where our receiver differs |
| [self-hosted-storage/](self-hosted-storage/index.md) | Relay to Kafka to consumers to ClickHouse, nodestore, filestore and Postgres, with schemas and retention |
| [read-apis/](read-apis/index.md) | Every API Muninn can read: replays and segments, sessions, issues, events, traces, logs, profiles, auth, pagination, sync recipe |

## Top findings

1. **A 200 from Relay does not mean the data was stored.** A gzip replay body, a replay event without its recording and a legacy `user_report` next to a `feedback` item all got a 200 and were not stored. One event-like item per envelope: an error plus a `replay_event` gets a 413 for the whole envelope ([wire-format/replay-wire.md](wire-format/replay-wire.md), [wire-format/envelope.md](wire-format/envelope.md)).
2. **Browser 11.x streams spans as `span` v2 items by default**, not transactions. Client reports leave only on page hide, and a tab closed right after activity loses the last replay segment. Rate limits are only honoured when the 429 is readable through CORS ([browser-sdk/](browser-sdk/index.md)).
3. **Mobile SDKs delete an envelope on any HTTP 4xx or 5xx**; only network errors keep it. The disk cache holds 30 envelopes by file count. Replay pauses while offline or rate-limited, leaving a gap. In React Native, JS `beforeSend` never sees events the native SDKs create. Video replay at 1 fps in 5 s segments measured 165 KB/min on iOS and 212 KB/min on Android with default masking (415 and 421 KB/min unmasked) over a 2-minute scripted journey ([mobile-sdks/replay-mobile.md](mobile-sdks/replay-mobile.md)).
4. **Storage:** full events live in a seaweedfs nodestore bucket (zstd), replay segments are zlib files in filestore, spans, logs and trace metrics share `eap_items_1_local`, and sessions exist only as metric aggregates ([self-hosted-storage/](self-hosted-storage/index.md)).
5. **Muninn can read replays through four public endpoints**, but the segment list hides gaps and time windows use SDK timestamps. There is no replay webhook, so Muninn must poll. Self-hosted has no API rate limits ([read-apis/](read-apis/index.md)).
6. **Our `ouosentryreceiver` translates 7 of 22 item types**, does not translate browser replays, and on a 429 drops items Sentry accepted ([wire-format/ouo-receiver-gaps.md](wire-format/ouo-receiver-gaps.md)).
