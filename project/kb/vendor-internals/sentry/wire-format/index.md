# Sentry wire format (Relay 26.10.0)

What a Sentry SDK sends, what Relay accepts, and how Relay answers. Pinned to Relay 26.10.0 (the version in self-hosted Sentry 26.10.0), Sentry 26.10.0, Snuba 26.10.0. Researched 2026-11-10 by `sentry-wire-storage` (Step 6): Relay source at the tag, develop docs, and about 100 hand-crafted requests against self-hosted Relay. Start with the explainer.

| Path | What it is |
|---|---|
| [wire-format-explainer.html](wire-format-explainer.html) | Picture of the envelope framing and every item type, with categories, topics and limits |
| [envelope.md](envelope.md) | How is an envelope framed, which header fields matter, what breaks parsing, and which item combinations get a 413? |
| [item-types/](item-types/index.md) | For every item type Relay knows: payload schema, data category, Kafka topic, what we observed |
| [replay-wire.md](replay-wire.md) | How do `replay_event`, `replay_recording` and `replay_video` look, how does Relay process and scrub them, and where do they go? |
| [otlp-ingest.md](otlp-ingest.md) | Which OTLP endpoints does Sentry have, with which content types and auth, and how are OTLP spans and logs mapped? |
| [auth-and-endpoints.md](auth-and-endpoints.md) | Which ingest routes exist, how is the public key found, and what does each route answer? |
| [limits-and-rate-limits.md](limits-and-rate-limits.md) | Every size limit, the data category of every item, the `X-Sentry-Rate-Limits` grammar, an observed 429, and the status codes |
| [ouo-receiver-gaps.md](ouo-receiver-gaps.md) | Where does our `ouosentryreceiver` differ from Relay (facts only)? |
| [bridge-data-gaps-rn-apps.md](bridge-data-gaps-rn-apps.md) | What does a React Native app on the Sentry SDK alone (no navigation integration, 7.7.0) not give ouo through the bridge, and which small bridge changes would close it? |
| [fixtures/](fixtures/index.md) | Relay's recorded answers to each hand-crafted request, and the harness that sent them |

Related: storage behind Relay is in [../self-hosted-storage/](../self-hosted-storage/index.md). SDK-side behaviour is in Step 4, [../../../client-sdk-features/](../../../client-sdk-features/index.md).
