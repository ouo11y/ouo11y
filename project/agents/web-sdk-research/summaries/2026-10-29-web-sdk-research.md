# 2026-10-29 web SDK research

## What was done

- Nine appendices in [`project/kb/web-sdk-research/`](../../../kb/web-sdk-research/index.md), each
  grounded in source code at a pinned version: ouo on the web today (O, at `f4a3010`), Sentry
  JavaScript 11.10 (A), Datadog browser SDK 7.16 (B), posthog-js 1.442 (C), OTel-shaped web RUM
  (D: Faro, Splunk, Honeycomb, Embrace, Elastic, Dash0, opentelemetry-browser, semconv 1.44),
  replay specialists (E), a 25-vendor landscape (F) and a measured benchmark of six SDKs on one
  page (M).
- [comparison.md](../../../kb/web-sdk-research/comparison.md): capability table, technique matrix,
  replay practices, OTel position, performance claims, ranked recommendations.
- [roadmap.md](../../../kb/web-sdk-research/roadmap.md): ten work packages WB1–WB10 ordered by
  value per cost, four lanes, milestones M1–M5, web column of the shared maturity ladder,
  decisions to take as ADRs, definitions of done.
- Two HTML reports in `reports/`: research (matrices, coverage of 25 vendors, measured footprint)
  and roadmap (lanes, value against cost, maturity, competitive table).

## Answer in short

The SDK (capture, delivery, privacy defaults, offline store, OTel semconv) is at or ahead of the
leaders; measured without replay it has the smallest eager bundle and main-thread cost in the same band as Sentry and Datadog. The read side is behind: no issue grouping, no
vitals aggregates or attribution, no shipped alerts, thin search. Replay costs more than Datadog's
(rrweb chunk 79.5 KB vs a 15.3 KB recorder, +161 ms/min main-thread; `@rrweb/record` measures 22.9 KB). WB1 → WB10 → WB2/WB3 → WB5 closes most of it.

## Verified and how

- Every ouo claim in Appendix O cites `path:line` at `f4a3010`; spot-checked by hand:
  `sdk/browser/src/version.ts` says `0.2.0` while `package.json` is `0.3.0` (also on `origin/main`;
  release-please `extra-files` does not list `version.ts`), `recorder.ts:109` imports `rrweb`,
  `vitals.ts:1` imports `web-vitals`, OTel deps in `sdk/browser/package.json:74-87`.
- Benchmark: 108 runs ok, 0 failed, 0 non-local requests; report tables regenerated from the raw
  JSON by `report.mjs` and copied verbatim. The eager ouo size (46,407 B gzip -9) checked against
  `dist/sizes.json`.
- Both HTML reports opened in the browser pane; they render without scripts or network.
- `lychee --offline` clean (see commit).

- Review round 1 (PR #110): delta IQRs now printed by `report.mjs`; `@rrweb/record` (22,934 B vs
  81,568 B gzip) and the replay bytes by event type (`snapshot.mjs`) measured on 2026-10-30 at
  load average 4.4–4.8 and reported in benchmark §8.

## Left

- Fix `SDK_VERSION` (WB1), not done on this research branch.
- ADRs from roadmap §8 not written.
- ~40 `[recall]` cells in F §6.1 need a source recheck (F §9 Q10).
- Benchmark: tenth round not run; no throttled-CPU or Firefox/WebKit cells; why rrweb's incremental
  stream is 3.5× Datadog's decoded bytes is not measured (WB5 should split it by source).

## Next agent must know

- No dependency added to the repo. The harness (`tools/web-bench/`) installs its own pinned
  devDependencies in a scratch directory (README); nothing is installed in the workspace.
- The Sentry browser SDK through the bridge (N39) is studied in a separate session; the
  `browser.web_vital` record names and the issues/vitals views (WB2, WB3) should serve both paths.
- Business wording stays out of this repo: these files hold engineering facts only.
- Links to `../mobile-sdk-research/` resolve only once PR #104 is merged (this branch is stacked
  on it).
