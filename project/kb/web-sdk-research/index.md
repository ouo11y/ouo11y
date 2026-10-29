# Web SDK research: Sentry, Datadog, PostHog, the OpenTelemetry field and the replay specialists

Started 2026-10-29. Question: how do the browser RUM / session replay SDKs really work (grounded in their source code where it is open), what do they cost in the page (bundle, main thread) and on the wire, which signals and frameworks they cover, whether they export OpenTelemetry, how `@ouo11y/browser` and the ouo stack compare today, and what ouo should build next on the web (the founder's 2026-10-23 focus item 1: "web SDK robust"). Companion to [mobile-sdk-research/](../mobile-sdk-research/index.md); the Sentry browser SDK through the bridge (N39) is a separate study.

Every appendix follows the same structure so the comparison can be read side by side. Facts carry a source: `repo/path:line @ sha`, a doc URL, or "measured here". Claims that could not be grounded in code are marked `[docs only]` or `[blog only]`.

| File | What it covers |
|---|---|
| [comparison.md](comparison.md) | Side-by-side synthesis: where ouo stands per capability (ahead / par / behind / absent), technique matrix of ouo, Sentry, Datadog, PostHog, Faro and Dash0, replay practices ouo lacks, OpenTelemetry position, performance claims and how they were measured, ranked recommendations |
| [roadmap.md](roadmap.md) | Recommendation (2026-10-29): how competitive ouo is on the web, ten work packages WB1–WB10 ordered by value per cost with exit criteria, four lanes, Datadog vs Sentry vs PostHog per part, the web column of the shared C1–C12 maturity ladder, what widens ouo's existing differences, what is still missing after WB10, decisions needed |
| [ouo-web-today.md](ouo-web-today.md) | Appendix O: `@ouo11y/browser`, the collector, rum-api and the Grafana plugin as they stand on the web, read from this repository |
| [sentry-javascript.md](sentry-javascript.md) | Appendix A: sentry-javascript (`@sentry/browser`, replay, tracing, feedback, profiling, framework packages) |
| [datadog-browser-sdk.md](datadog-browser-sdk.md) | Appendix B: DataDog/browser-sdk (RUM, logs, session replay with its own recorder) |
| [posthog-js.md](posthog-js.md) | Appendix C: posthog-js (replay on rrweb, autocapture, heatmaps, web vitals, exceptions, surveys, analytics) |
| [otel-native-web.md](otel-native-web.md) | Appendix D: OpenTelemetry-shaped web RUM: Grafana Faro, the OTel browser SIG, opentelemetry-js-contrib, Splunk, Honeycomb, Embrace, Elastic, LaunchDarkly (Highlight), Dash0 |
| [replay-specialists.md](replay-specialists.md) | Appendix E: replay engines and specialists: rrweb itself, Microsoft Clarity, OpenReplay, LogRocket, Fullstory, Hotjar / Contentsquare |
| [landscape-closed.md](landscape-closed.md) | Appendix F: the rest of the field (New Relic, Dynatrace, AppDynamics, Bugsnag, Raygun, Rollbar, mPulse, Vercel, Cloudflare, Akamai and others) and the web feature matrix |
| [benchmark.md](benchmark.md) | Appendix M: measured here: bundle size, main-thread cost and bytes on the wire for ouo, Sentry, Datadog, PostHog, Faro and Splunk on one page and one journey |

## Appendix structure (A–F)

1. **Sources**: repos with the exact commit / tag studied, docs and blog URLs, which parts are open source.
2. **Packages and frameworks**: npm packages, CDN / loader snippet, framework integrations (React, Next.js, Vue, Nuxt, Angular, Svelte, Remix / React Router), browser support floor, module format, lazy loading.
3. **RUM**: what is captured and the exact flow of each with code references: sessions (id, storage, timeouts, cross-tab, cross-subdomain), errors (handlers, stack parsing, client-side grouping hints), web vitals (library, attribution, INP), page loads and soft navigations, resources, network (fetch / XHR, propagation headers, body capture), long tasks / LoAF, user interactions and frustration signals (rage, dead, error clicks), console and logs, custom events and spans, feature flags.
4. **Session replay**: recorder (rrweb, fork, own), snapshot and mutation handling, masking defaults, canvas / iframes / shadow DOM / web components, compression (worker or not, library), segmenting, sampling modes (session, on error), network and console data in the replay, how replay links to errors and traces, the player.
5. **Transport and OpenTelemetry**: endpoint, batch format, compression, page-hide delivery, offline storage, retries, tunnel / first-party proxy for ad blockers, CSP needs; whether anything is OTLP or bridges to OTel.
6. **Other features**: issue grouping and workflow, source maps, release health, alerting, heatmaps, funnels and journeys, product analytics, feedback widget, surveys, profiling (JS Self-Profiling), feature flags, consent / cookieless modes.
7. **Performance footprint**: vendor numbers and how they measured them, bundle size per entry, what the code does on the main thread vs workers.
8. **Blog-to-code grounding**: for each performance or capability claim in a vendor blog, the commit or file that implements it.
9. **Questions asked and answers**, each with a code reference.
10. **Takeaways for ouo**.

Rule for every file: engineering facts only. No pricing, plans, sales or positioning wording (AGENTS.md: business material lives in `ouo11y/company`).

HTML reports: [web-sdk-research.html](../../agents/web-sdk-research/reports/web-sdk-research.html) (matrices and the measured footprint) and [web-sdk-roadmap.html](../../agents/web-sdk-research/reports/web-sdk-roadmap.html) (lanes, value against cost, maturity, competitive table).
