# collector

Owns `collector/` (ocb manifest, `ouoreplay` receiver and exporter, `ouoratelimit` processor and extension, `ouoauth` extension, Dockerfile) and the reference collector config under `deploy/compose/collector/`.

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a rev 2: distribution, three components, config, verification
  - [2026-10-23-bridge-parity.md](summaries/2026-10-23-bridge-parity.md) Sentry bridge parity fixes A1 to A11, C5, N2 findings; live run against self-hosted Sentry
  - [2026-10-23-n13-n15-edge-qa.md](summaries/2026-10-23-n13-n15-edge-qa.md) N13 auth-failure counter, empty exports rate limited, `internal` project, module tags; N15 live edge QA automated; N16 docs drift; N4 bridge replica doc
  - [2026-10-31-n75-bridge-feedback.md](summaries/2026-10-31-n75-bridge-feedback.md) N75: held `user_report` items until their error, bridge feedback in the sentry-mobile CI journey and verify
  - [2026-11-24-numeric-user-id.md](summaries/2026-11-24-numeric-user-id.md) a numeric event `user.id` no longer fails the event's decode (browser apps lost every error after login)
- `reports/`
  - [n15-edge-qa.html](reports/n15-edge-qa.html) edge QA run (N15 + N13): eight checks, one finding (V1)
  - `n15-runs/` raw results of that run (`edge-qa-default.json`, `edge-qa-limits.json`)
