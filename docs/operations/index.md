# Operations

Operator-facing procedures. Install guides live next to the deployment files
(`deploy/README.md`, `deploy/helm/ouo/README.md`, `deploy/vm/`).

| File | Content |
|---|---|
| [upgrade.md](upgrade.md) | upgrade procedure for the compose and Helm paths, replay `schema_version` compatibility rule, rollback (the component matrix is `../compatibility.md`) |
| [existing-lgtm.md](existing-lgtm.md) | run ouo on an existing Loki / Tempo / Mimir behind the customer's OTel collectors: required Loki settings (additive OTLP labels), delete-by-user, Tempo, Mimir, retention, tenants, Helm / compose, verification (`tests/e2e/existing-lgtm/`) |
| [data-lifecycle.md](data-lifecycle.md) | retention per signal (one values entry), replay sweeper and S3 lifecycle rules, delete by user / project, the deletion audit log, sampling; live verification (roadmap 8b) |
| [masking-proof.md](masking-proof.md) | what a web and an iOS replay contain with the default masking, live screen next to the stored replay, screenshots in `masking-proof/` |
