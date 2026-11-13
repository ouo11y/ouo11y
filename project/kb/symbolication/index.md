# Symbolication

How minified and native stack traces become original files, lines and functions once `services/rum-api` is gone: where debug files are stored, how they are uploaded, and how `ouo-go` resolves a stack. Design: [ADR-0022](../../../docs/adr/0022-debug-files-without-rum-api.md). Report with the measurements: [source-maps-without-rum-api.html](../../agents/symbolication/reports/source-maps-without-rum-api.html).

| Path | What it is |
|---|---|
| [source-maps/](source-maps/index.md) | What the prototype measured and learned about storing source maps as write-once files and resolving on read |
| [vendors/](vendors/index.md) | How Sentry, Datadog, PostHog and Grafana Alloy key, upload and resolve, with the sources read |

The MVP-era entries are still the reference for the build side: [debug ids and the Go parser](../../kb-archive/sourcemaps-symbolication.md), [Hermes](../../kb-archive/hermes-sourcemaps.md), [dSYM](../../kb-archive/dsym-symbolication.md). What this work took from them was checked against the code and the prototype's tests; the storage and cache sections of the first one describe rum-api and are replaced by ADR-0022.
