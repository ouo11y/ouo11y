# Muninn

Muninn is ouo's replay store (post-MVP step 8). Entries here hold the evidence and working notes behind its design and build. Decisions are in [ADR-0019](../../../docs/adr/0019-collector-to-muninn.md) and the contract in [docs/specs/muninn.md](../../../docs/specs/muninn.md).

| Folder | What it covers |
|---|---|
| [collector-path/](collector-path/index.md) | How a replay chunk gets from an SDK through the Collector into Muninn and back out to a player, with an HTML explainer |
| [sentry-bridge/](sentry-bridge/index.md) | The Sentry bridge next to Muninn in one collector: where each output lands, back-pressure, the rate-limit trap behind a proxy, replaying old captures |
| [implementation/](implementation/index.md) | Building Muninn and the spec-wire Collector config: what running it settled, read-path gzip pitfalls, library quirks |
