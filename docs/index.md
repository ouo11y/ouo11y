# Docs

| File | Content |
|---|---|
| [MVP.md](MVP.md) | MVP scope and acceptance checks |
| [VISION.md](VISION.md) | long-term product vision (not MVP scope) |
| [specs/session-lifecycle.md](specs/session-lifecycle.md) | normative session spec |
| [specs/mobile-replay.md](specs/mobile-replay.md) | frame-chunk contract and iOS capture rules |
| [specs/sentry-bridge.md](specs/sentry-bridge.md) | Sentry envelope to ouo mapping, forwarding rules, session resolution, `video` replay chunk and rum-api video API (ADR-0008, accepted 2026-10-17) |
| [specs/mobile-vitals.md](specs/mobile-vitals.md) | mobile vitals (app start, TTID, frames, stalls) as session events, shared by the Sentry bridge and the ouo SDK; rum-api vitals endpoint |
| [adr/](adr/README.md) | architecture decision records |
| [../examples/fast-tracked/index.md](../examples/fast-tracked/index.md) | copy-and-paste onboarding: stack, Go backend, React, Expo iOS |
| [releasing.md](releasing.md) | the one releasing document: components and tags, versioning, conventional commits, release-please flow, the founder's release checklist, dry runs, pull access, accounts and secrets, supply chain |
| [compatibility.md](compatibility.md) | compatibility matrix: which SDK, collector, rum-api, plugin and chart lines work together, replay `schema_version`; checked on every release PR |
| [operations/upgrade.md](operations/upgrade.md) | operator upgrade procedure (compose and Helm), replay schema-version rule, rollback (index: [operations/index.md](operations/index.md)) |
