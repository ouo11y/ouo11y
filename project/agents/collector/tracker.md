# collector tracker

| Date | Event |
|---|---|
| 2026-10-13 | Phase 8a rev 2 done: ouo-collector (ocb 0.160.0) with ouoreplay receiver/exporter and ouoratelimit (429 + Retry-After, key_from address/x_forwarded_for), reference config + dev htpasswd, Dockerfile, CI + release image, standalone verification. [summary](summaries/2026-10-10-phase-8a.md) |
| 2026-10-13 | ADR-0008 proposed: a fourth component, the `ouosentry` receiver (Sentry envelope endpoint, forward to upstream Sentry, translate to OTLP and `video` replay chunks). Spec `docs/specs/sentry-bridge.md`, knowledge in `project/kb/sentry-envelope-format.md`. Not started; first task is the envelope capture. |
| 2026-10-14 | `ouosentry` receiver built (forward, translate, replay) plus `tools/sentrytap`, routing connector in the manifest; verified on real iOS traffic (S1 to S3 of the Sentry bridge). Summary in `project/agents/orchestrator/summaries/2026-10-14-sentry-bridge-build.md`. |
| 2026-10-23 | Bridge parity (checklist section 2): A1, A2, A3, A5 to A9, A11, C5 and the N2 findings in `ouosentry`, with unit and golden tests (new golden `selfhosted`, journey without replay); verified live against self-hosted Sentry (83/83 byte-identical, errors / sessions / logs equal to Sentry's). [summary](summaries/2026-10-23-bridge-parity.md) |
