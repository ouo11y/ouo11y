# 2026-10-17 bridge vs ouo SDK comparison

## Done
- Isolated stack `ouo-cmp` on released 0.2.0 images (collector, grafana, rum-api). Ports: Grafana 3009, rum-api 8097,
  Loki 3109, Tempo 3209, Mimir 9019, OTLP 4378, replay 4379, bridge 4380, backend 8089. The demo backend reused the
  `ouo-sb-backend` image: a Docker Hub pull of `golang:1.26` timed out, and `examples/backend` has not changed since
  2026-10-06. Own simulator "ouo-cmp iPhone 18 Pro" and own DSN tap port 4410, so the sibling sessions did not collide.
- Three runs of the same journey with real simulator taps, `OUO_SDK=1`:
  1. ouo replay on, ouo navigation not wired, as the demo shipped.
  2. ouo replay off, navigation wired.
  3. ouo replay on, navigation wired.
- Compared field by field: rum-api sessions, detail, logs and replay; Loki records and keys per event name; Tempo
  traces, span names and attributes; Mimir series; the raw Sentry envelopes (sentrytap); the plugin pages (Grafana
  13.2.1, browser pane).
- Report `project/reports/bridge-vs-sdk.html` lists the gaps:
  - 11 (a): fixable in the bridge from data Sentry sends; ~11 d for ten of them, plus source maps on the roadmap
  - 4 (b): only the ouo SDK
  - 9 (c): cosmetic or plugin
  It also lists where the bridge is ahead of the ouo SDK, the parallel-mode traps and pitch guidance.
- kb `project/kb-archive/sentry-bridge-vs-ouo-sdk.md`. Tracker items A1 to A11 in `project/tracker/roadmap.md` ("Bridge parity gaps").
- Demo app (`examples/sentry-mobile`, owned by this agent), changed so the comparison is fair. No product code
  changed:
  - `App.tsx` wires `RUMProvider` and `navigationStateListener` in parallel mode, as the SDK README says.
  - New build flag `OUO_REPLAY=0` turns off the ouo replay.

## Verified and how
- Counts from rum-api `GET /v1/sessions` and the session detail; Loki `query_range` dumps; Tempo `/api/search` and
  `/api/traces`; Mimir label and series queries.
- Raw envelopes decoded from the sentrytap captures, for example Sentry `session.errors` = 2 against the bridge's 3.
- Plugin pages read with `get_page_text` for the run-2 pair and the run-3 ouo replay.
- `tsc --noEmit` clean for the demo change. The change was exercised in runs 2 and 3: ouo navigation events appeared.

## Left
- The run-1 Sentry replay was cut short (41 s of 128 s, 0 touches) and did not reproduce in run 3. Rerun a few
  parallel sessions before saying the two replays coexist.
- Nothing in A1 to A11 is implemented (the task said not to fix anything).
- Android is not covered.

## Next agent must know
- Do not demo the bridge in parallel mode: ouo owns `traceparent`, so bridged traces lose their backend spans.
- Sentry RN `propagateTraceparent` defaults to false. Backend correlation through the bridge needs that one line.
- Compose project `ouo-cmp` was stopped with `docker compose -p ouo-cmp down` (no `-v`, so the volumes and data are
  kept). The sentrytap on 4410 was stopped, and the simulator "ouo-cmp iPhone 18 Pro" (99B29D52-F88B-44D2-82AC-C8F83F9BBA85)
  was shut down but not deleted. Bring the stack back with the same `-p ouo-cmp` and port env. Its Grafana predates
  the admin / testing567 rule (PR #22): reset the password with `grafana cli admin reset-admin-password testing567`
  before handing out a URL.
