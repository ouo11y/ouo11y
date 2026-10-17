# collector tracker

| Date | Event |
|---|---|
| 2026-10-13 | Phase 8a rev 2 done: ouo-collector (ocb 0.160.0) with ouoreplay receiver/exporter and ouoratelimit (429 + Retry-After, key_from address/x_forwarded_for), reference config + dev htpasswd, Dockerfile, CI + release image, standalone verification. [summary](summaries/2026-10-10-phase-8a.md) |
| 2026-10-13 | ADR-0008 proposed: a fourth component, the `ouosentry` receiver (Sentry envelope endpoint, forward to upstream Sentry, translate to OTLP and `video` replay chunks). Spec `docs/specs/sentry-bridge.md`, knowledge in `project/kb/sentry-envelope-format.md`. Not started; first task is the envelope capture. |
| 2026-10-14 | `ouosentry` receiver built (forward, translate, replay) plus `tools/sentrytap`, routing connector in the manifest; verified on real iOS traffic (S1 to S3 of the Sentry bridge). Summary in `project/agents/orchestrator/summaries/2026-10-14-sentry-bridge-build.md`. |
