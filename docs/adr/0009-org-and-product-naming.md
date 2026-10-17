# ADR-0009 Org and product naming: `ouo11y` everywhere, plain product names, `ouo` as the short internal namespace

Status: proposed (2026-10-17). Name, spelling and pronunciation chosen by the founder on 2026-10-17. The GitHub org `ouo11y` and the domain `ouo11y.com` are already claimed.

## Context

SDK publishing (npm scope, the iOS mirror repo, Grafana plugin signing, container registry, Go module paths) needs a fixed org name before anything is published. Once SDKs are installed in customers' apps, renaming means a breaking release for every consumer, so this has to be settled first.

Today everything is named after the working title `ouo` under the founder's personal GitHub account: `@ouo/browser`, `@ouo/react-native`, `sdk/ios`, `ouo-rum-app`, `ghcr.io/ziadmansourm/ouo/*`, `github.com/ZiadMansourM/ouo/...`. The bare name `ouo` is taken on GitHub (a user account) and on npm (a package from 2021). The `ouo.*` domains already resolve.

The product's position: OTel-native Real User Monitoring. Data is OTLP and follows OTel semantic conventions, there is no proprietary format, and leaving ouo11y loses neither the data nor the instrumentation. The name stands for **Open Unified Observability**.

## Decision

1. **Org name: `ouo11y`, always lowercase.** It is an identifier everywhere: GitHub org, npm scope, domain, registry, plugin IDs, Go module paths. Prose and logos also write `ouo11y`. Never `OUO11y`, `Ouo11y` or `ouo11Y`.

2. **Pronunciation:** "oh-you-oh-eleven-why" in full, **"ouo"** for short. The README states both.

3. **Tagline:** *Open Unified Observability.* It goes in taglines and descriptions, not in identifiers.

4. **Products get plain names under the org.** No separate brand per product:

   | Product | Identifier |
   |---|---|
   | Browser SDK | `@ouo11y/web` (renamed from `@ouo/browser`) |
   | React Native SDK | `@ouo11y/react-native` |
   | iOS SDK | `ouo11y-ios` (SwiftPM mirror repo `github.com/ouo11y/ouo11y-ios`) |
   | Sentry bridge | ouo11y bridge (the `ouosentry` receiver in the collector) |
   | Ingest service | ouo11y rum-api |
   | Collector distribution | ouo11y collector |
   | Grafana app plugin | `ouo11y-rum-app` (Grafana plugin IDs are `<org>-<name>-<type>`; the grafana.com org slug must be `ouo11y` for signing) |
   | Container images | `ghcr.io/ouo11y/<component>`, e.g. `ghcr.io/ouo11y/collector`, `ghcr.io/ouo11y/rum-api` |
   | Go modules | `github.com/ouo11y/<repo>/...` |
   | Web | `ouo11y.com` |

   A future standalone product (for example the anomaly detection model) may get its own name in a later ADR. Until then it is "ouo11y <plain noun>".

5. **`ouo` stays as the short internal namespace in places that are not the brand:**
   - OTel attribute prefix `ouo.` (from AGENTS.md and the event schema). It costs bytes on every event, and dashboards and queries already depend on it.
   - Collector component type names: `ouosentry`, `ouoreplay`, `ouoratelimit`. Users type these in collector config, and they match the short name.

   This matches the short pronunciation "ouo", so it reads as one name, not two.

6. **Claim lookalikes against typosquatting.** `1` and `l` are easy to confuse, so register `ouolly` on GitHub and npm, park it, and point it to `ouo11y`. Do the same for any other variant that becomes a problem.

7. **Claim before publishing.** Before the first public SDK release, the following must exist under the founder's control: GitHub org `ouo11y` (done), domain `ouo11y.com` (done), npm org `ouo11y`, grafana.com org `ouo11y`, and the lookalikes in point 6.

## Consequences

- The repo moves from `github.com/ZiadMansourM/ouo` to the `ouo11y` org, and every Go module path changes with it. Doing this before any external consumer imports the modules costs one mechanical PR. The repo name inside the org is still open (`ouo11y/ouo11y` is the default).
- npm packages are renamed before their first public publish, so no deprecation shims are needed. `@ouo/browser` becomes `@ouo11y/web`.
- The Grafana plugin ID changes from `ouo-rum-app` to `ouo11y-rum-app`. Provisioning files, dashboards that reference the plugin, and the plugin's routes all change in the same PR. Since nothing is signed or published yet, no migration is needed.
- Images move from `ghcr.io/ziadmansourm/ouo/*` to `ghcr.io/ouo11y/*`. They stay private until stable (same rule as today), and examples still need `docker login ghcr.io`.
- The `ouo.` attribute prefix and the `ouo*` collector component names do not change. Stored telemetry, dashboards and collector configs keep working.
- Claims in public copy stay checkable: "OTel-native: OTLP out, semantic conventions, no proprietary format", not "guaranteed future compatibility with OTel". No "first" claims until they can be backed.
