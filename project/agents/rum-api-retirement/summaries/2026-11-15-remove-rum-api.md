# 2026-11-15: remove rum-api, the MVP plugin and the MVP replay path

## Done
- Deleted `services/rum-api`, `plugins/ouo11y-rum-app`, `collector/receiver/ouoreplayreceiver`, `collector/exporter/ouoreplayexporter`, `docs/MVP.md`, `deploy/compose/{rum-api/,compose.s3.yaml,compose.muninn.yaml}`, `deploy/images/{grafana,rum-api}`, `release-plugin.yml`, their release-please components, compatibility rows, CI jobs and image builds, and the `plugins/*` npm workspace.
- The `ghcr.io/ouo11y/grafana` image was stock Grafana plus the plugin and nothing else, so it went too: compose and Helm use `grafana/grafana:13.2.5`.
- Muninn is the default replay path: `collector/config.yaml` is the former `config.muninn.yaml` plus the Sentry bridge (:4320). The bridge's video replay chunks go to the `debug` exporter because nothing stores them. Muninn, MinIO and muninn-init are in `compose.yaml`; `--muninn` is gone from `ouo-env`.
- Helm: rum-api and the plugin are removed. The collector sends to a required `muninn.endpoint` (the chart does not deploy Muninn).
- Deleted the e2e tests that read rum-api: `tests/e2e/{scenario,edge-qa,lib}.mjs`, `mobile/`, `mobile-native/`, `mobile-android/`, `rn-background/`, `existing-lgtm/`, `otel-sdk/`, `sdk/ios/Tests/OuoSDKTests/RealCollectorTests.swift`, and `deploy/scripts/{e2e,qa-edge}.sh`. Also deleted the quickstarts `tiny-shop-funnels` and `quickstarts-mobile` (plugin only) and `examples/tools/rumcheck.py`. The verify scripts were trimmed to their Loki, Tempo and Muninn checks. release-check now runs `wait-ready.sh` and `smoke.sh`.
- Checklist: N8, N11, N28, N30, N41 and N90 are closed; Q1 is rewritten.

## Verified
- `npm ci`, plus `npm run typecheck` and `npm run test` across the workspaces (after building `sdk/browser`).
- `go vet` and `go test` on `ouosentryreceiver`.
- The collector, built with ocb v0.160.0, validates `config.yaml`.
- `helm lint`, compat-check, `ouo-env` tests (16/16), `gen-quickstart --check`, check-embeds and lychee (0 errors).
- `ouo-env up` brought up a stack, `smoke.sh` passed, Muninn `/ready` returned 200, and the env was taken down.

## Left / next agent must know
- The released collector 0.5.0 has no `file_storage`. `compose.images.yaml`, `quickstart.yaml` and the Helm default work with the new config only after the next collector release (the `refactor!` commit triggers it).
- The native iOS and Android replay uploaders still post to `:4319/v1/replay/chunks`, which no longer exists. They must move to OTLP `/v1/logs` (SDK work, its own item).
- `tiny-shop` is still on `@ouo11y/browser ^0.2.1`, whose replay targets 4319.
- The mobile SDK conformance suite is gone; it needs a Muninn/Loki-based rewrite.
- `docs/operations/{existing-lgtm,upgrade,data-lifecycle}.md` carry a removal banner, but their bodies still describe rum-api.
- The Helm collector is a Deployment with an emptyDir replay queue: a StatefulSet volume is not done (Q12).
