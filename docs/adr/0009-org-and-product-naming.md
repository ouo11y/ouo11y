# ADR-0009 Org and product naming: `ouo11y` everywhere, plain product names, `ouo` as the short internal namespace, three repos

Status: accepted (2026-10-18). Name, spelling and pronunciation chosen by the founder on 2026-10-17; the browser SDK name, the repo name and the three-repo split decided by the founder on 2026-10-18. The GitHub org `ouo11y` and the domain `ouo11y.com` are claimed. The repo was transferred from `ZiadMansourM/ouo` to `ouo11y/ouo11y` on 2026-10-18 (GitHub redirects the old URL).

## Context

SDK publishing (npm scope, the iOS mirror repo, Grafana plugin signing, container registry, Go module paths) needs a fixed org name before anything is published. Once SDKs are installed in customers' apps, renaming means a breaking release for every consumer, so this has to be settled first.

Until 2026-10-18 everything was named after the working title `ouo` under the founder's personal GitHub account: `@ouo/browser`, `@ouo/react-native`, `sdk/ios`, `ouo-rum-app`, `ghcr.io/ziadmansourm/ouo/*`, `github.com/ZiadMansourM/ouo/...`. The bare name `ouo` is taken on GitHub (a user account) and on npm (a package from 2021). The `ouo.*` domains already resolve.

The product's position: OTel-native Real User Monitoring. Data is OTLP and follows OTel semantic conventions, there is no proprietary format, and leaving ouo11y loses neither the data nor the instrumentation. The name stands for **Open Unified Observability**.

The repo also held business material (product plan, go-to-market, prospects) next to the code. Licensing is already split by folder (Apache-2.0 for the SDKs and the plugin, AGPL-3.0 for rum-api), so the product may be open-sourced later; the business material must not be in it when that happens.

## Decision

1. **Org name: `ouo11y`, always lowercase.** It is an identifier everywhere: GitHub org, npm scope, domain, registry, plugin IDs, Go module paths. Prose and logos also write `ouo11y`. Never `OUO11y`, `Ouo11y` or `ouo11Y`.

2. **Pronunciation:** "oh-you-oh-eleven-why" in full, **"ouo"** for short. The README states both.

3. **Tagline:** *Open Unified Observability.* It goes in taglines and descriptions, not in identifiers.

4. **Products get plain names under the org.** No separate brand per product:

   | Product | Identifier |
   |---|---|
   | Browser SDK | `@ouo11y/browser` (renamed from `@ouo/browser`; matches its folder `sdk/browser` and how Sentry and Datadog name theirs. OTel JS itself says "web", as in `@opentelemetry/sdk-trace-web`) |
   | React Native SDK | `@ouo11y/react-native` (renamed from `@ouo/react-native`) |
   | iOS SDK | SwiftPM package `ouo11y-ios`, served from the mirror repo `github.com/ouo11y/ouo11y-ios`; library products and modules stay `OuoReplay` and `OuoReplayCore` (see point 5) |
   | Sentry bridge | ouo11y bridge (the `ouosentry` receiver in the collector) |
   | Ingest service | ouo11y rum-api |
   | Collector distribution | ouo11y collector |
   | Grafana app plugin | `ouo11y-rum-app` (Grafana plugin IDs are `<org>-<name>-<type>`; the grafana.com org slug must be `ouo11y` for signing). Its folder becomes `plugins/ouo11y-rum-app` |
   | Container images | `ghcr.io/ouo11y/<component>`: `ghcr.io/ouo11y/collector`, `ghcr.io/ouo11y/grafana`, `ghcr.io/ouo11y/rum-api` |
   | Go modules | `github.com/ouo11y/ouo11y/<path>`, e.g. `github.com/ouo11y/ouo11y/services/rum-api` |
   | Web | `ouo11y.com` |

   A future standalone product (for example the anomaly detection model) may get its own name in a later ADR. Until then it is "ouo11y <plain noun>".

5. **`ouo` stays as the short internal name in code**, in places that are not the brand:
   - OTel attribute prefix `ouo.` (from AGENTS.md and the event schema). It costs bytes on every event, and dashboards and queries already depend on it.
   - Collector component type names: `ouosentry`, `ouoreplay`, `ouoratelimit`. Users type these in collector config, and they match the short name.
   - Swift module names `OuoReplay` and `OuoReplayCore`. Swift modules are UpperCamelCase identifiers, and `Ouo11yReplay` would break point 1's spelling rule; the brand is carried by the package name `ouo11y-ios`, which is also the SwiftPM package identity apps see (`.product(name: "OuoReplay", package: "ouo11y-ios")`).
   - Environment variables, binary names and the Helm chart name that already say `ouo` (`OUO_*`, `ouo-env`, chart `ouo`).

   This matches the short pronunciation "ouo", so it reads as one name, not two.

6. **Three repos under the org:**

   | Repo | Visibility | Holds |
   |---|---|---|
   | `ouo11y/ouo11y` | private now, may go public | The product monorepo: SDKs, collector, rum-api, plugin, deploy, examples, docs, specs, kb, engineering trackers (layout in [ADR-0010](0010-repository-layout.md)) |
   | `ouo11y/ouo11y-ios` | follows the product repo | A read-only mirror of `sdk/ios` that CI publishes on each iOS release, so SwiftPM can resolve the package from a repo root. Nobody commits to it. Publishing is roadmap B4 |
   | `ouo11y/company` | always private | Pricing, product plan, go-to-market, prospects, pitch kit, contracts, client notes |

   Engineering material (roadmap phases, checklists, agent trackers, kb) stays in the product repo. Anything about who we sell to, for how much, and how, goes to `company`. When an engineering file needs a business reason, it states the reason in one line and does not link into `company`.

7. **Claim lookalikes against typosquatting.** `1` and `l` are easy to confuse, so register `ouolly` on GitHub and npm, park it, and point it to `ouo11y`. Do the same for any other variant that becomes a problem.

8. **Claim before publishing.** Before the first public SDK release, the following must exist under the founder's control: GitHub org `ouo11y` (done), domain `ouo11y.com` (done), npm org `ouo11y`, grafana.com org `ouo11y`, and the lookalikes in point 7.

## Consequences

- The repo is `github.com/ouo11y/ouo11y` (transferred 2026-10-18), and every Go module path changes with it, including the collector's `builder.yaml` and its replace directives. Doing this before any external consumer imports the modules costs one mechanical PR.
- npm packages are renamed before their first public publish, so no deprecation shims are needed: `@ouo/browser` becomes `@ouo11y/browser`, `@ouo/react-native` becomes `@ouo11y/react-native`.
- The Grafana plugin ID changes from `ouo-rum-app` to `ouo11y-rum-app`. Provisioning files, dashboards that reference the plugin, the plugin's routes and rum-api's links all change in the same PR. Grafana treats a new ID as a different plugin: an existing install keeps the old one until it is removed, its app settings (rum-api URL, token) are not carried over, and old `/a/ouo-rum-app/...` links stop resolving. Nothing is signed or published yet, so the only installs are our own stacks; the CHANGELOG says how to move one.
- Images move from `ghcr.io/ziadmansourm/ouo/*` to `ghcr.io/ouo11y/*`. They stay private until stable (same rule as today), and examples still need `docker login ghcr.io`. Images already released exist only under the old path; references to the new path work from the next release on.
- The `ouo.` attribute prefix and the `ouo*` collector component names do not change. Stored telemetry, dashboards and collector configs keep working.
- Business material leaves the product repo for `ouo11y/company`. Deleting files does not remove them from git history: before the product repo goes public it is published with a fresh history or rewritten with `git filter-repo` on a copy. This is a tracked gate for going public.
- Claims in public copy stay checkable: "OTel-native: OTLP out, semantic conventions, no proprietary format", not "guaranteed future compatibility with OTel". No "first" claims until they can be backed.
