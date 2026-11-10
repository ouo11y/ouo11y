# Self-hosted Sentry 26.10.0 storage

Where every piece of Sentry data goes after Relay accepts it, in self-hosted Sentry 26.10.0 (`feature-complete`), observed on the local `sentry-sbx` stack and read from Relay, Sentry and Snuba source at tag 26.10.0. Researched 2026-11-10 by `sentry-wire-storage` (Step 6). Start with the explainer.

| Path | What it is |
|---|---|
| [storage-explainer.html](storage-explainer.html) | Pipeline picture: Relay → Kafka → consumers → ClickHouse, nodestore, filestore, Postgres |
| [pipeline.md](pipeline.md) | Which Kafka topic does each item go to, which container consumes it, which store does it end in, and where are drops visible? |
| [kafka-topics.md](kafka-topics.md) | Which 83 topics exist, with what partitions and retention, and what do the messages look like? |
| [clickhouse-schema.md](clickhouse-schema.md) | Which ClickHouse tables exist, with engine, ORDER BY, partitions and TTL, and which product reads which table? |
| [nodestore-postgres.md](nodestore-postgres.md) | Where are full event payloads (seaweedfs nodestore, not Postgres) and which Postgres tables matter? |
| [object-storage.md](object-storage.md) | Where do replay segments, attachments and profiles live, and in which byte format? |
| [retention.md](retention.md) | How long does each store keep data, and what does `sentry cleanup` delete? |
| [follow-one-event.md](follow-one-event.md) | One error event and one replay followed through every store, with the rows we found |
| [fixtures/](fixtures/index.md) | Schema dumps, topic list, redacted rows, decoded nodestore and replay objects |

Wire format in front of this: [../wire-format/](../wire-format/index.md).
