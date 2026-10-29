# Docs

| File | Content |
|---|---|
| [MVP.md](MVP.md) | MVP scope and acceptance checks |
| [VISION.md](VISION.md) | long-term product vision (not MVP scope) |
| [specs/session-lifecycle.md](specs/session-lifecycle.md) | normative session spec |
| [specs/mobile-replay.md](specs/mobile-replay.md) | frame-chunk contract and iOS capture rules |
| [specs/sentry-bridge.md](specs/sentry-bridge.md) | Sentry envelope to ouo mapping, forwarding rules, session resolution, `video` replay chunk and rum-api video API (ADR-0008, accepted 2026-10-17) |
| [funnels.md](funnels.md) | user guide: build and read a funnel in the plugin, what a step can be, counting rules, limits |
| [specs/funnels.md](specs/funnels.md) | funnel reports: steps (page path, custom event), strict order, `within`, session counting, range and filters, Loki reads, limits (ADR-0012) |
| [specs/mobile-vitals.md](specs/mobile-vitals.md) | mobile vitals (app start, TTID, frames, stalls) as session events, shared by the Sentry bridge and the ouo SDK; rum-api vitals endpoint |
| [adr/](adr/README.md) | architecture decision records |
| [../examples/fast-tracked/index.md](../examples/fast-tracked/index.md) | copy-and-paste onboarding: stack, Go backend, React, Expo iOS |
| [../examples/quickstarts/index.md](../examples/quickstarts/index.md) | standalone quickstart apps against the one-file stack: `tiny-shop` (Node API + React); `tiny-shop-funnels` (quickstart 5, funnels); `tiny-shop-otel` (no ouo SDK: OpenTelemetry + rrweb by hand) |
| [sourcemaps.md](sourcemaps.md) | readable stacks from minified web apps: upload tokens, `ouo-sourcemaps inject` / `upload`, Vite / webpack / Next.js setups, what the plugin shows, troubleshooting, retention (ADR-0011) |
| [symbolication.md](symbolication.md) | readable native iOS crashes: build UUIDs, `ouo-sourcemaps upload-dsym`, where Xcode puts dSYMs, what the plugin shows, checking an upload, limits (ADR-0011 section 7) |
| [releasing.md](releasing.md) | the one releasing document: components and tags, versioning, conventional commits, release-please flow, the founder's release checklist, dry runs, pull access, accounts and secrets, supply chain |
| [sentry-client-setup.md](sentry-client-setup.md) | for clients keeping `@sentry/react-native` behind the bridge: DSN, the Expo native-start trap, `propagateTraceparent` and `tracePropagationTargets`, `tracesSampleRate` and dropped backend traces, requests outside a transaction, a `beforeBreadcrumb` filter, never parallel mode while bridging, the ~30 s duration difference (C9) |
| [sentry-bridge-deployment.md](sentry-bridge-deployment.md) | run the Sentry bridge as one replica: what it keeps in memory, what breaks with two replicas or a restart, compose / VM, and a one-replica Kubernetes Deployment next to the Helm chart (N4) |
| [first-party-endpoint.md](first-party-endpoint.md) | serve the collector from the site's own origin so ad blockers do not drop browser telemetry: relative `endpoint`, nginx, Caddy, Next.js and Vite routes, rate limiting behind a proxy, `sendBeacon` through the proxy |
| [compatibility.md](compatibility.md) | compatibility matrix: which SDK, collector, rum-api, plugin and chart lines work together, replay `schema_version`; checked on every release PR |
| [operations/upgrade.md](operations/upgrade.md) | operator upgrade procedure (compose and Helm), replay schema-version rule, rollback (index: [operations/index.md](operations/index.md)) |
| [benchmarks.md](benchmarks.md) | device-cost benchmark ouo vs Sentry: fairness rules, tiers, metrics, how to run it, proposed release gate (B3) |
