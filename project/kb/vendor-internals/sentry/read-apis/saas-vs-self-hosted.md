# Sentry read API: SaaS versus self-hosted

> What changes for Muninn when the customer's Sentry is sentry.io instead of a self-hosted install?

Versions: Sentry self-hosted 26.10.0 (`getsentry/self-hosted` tag `26.10.0`); SaaS from public docs only (accessed 2026-11-10). No SaaS account was used (no sign-ups allowed). Research date 2026-11-10.

| Topic | Self-hosted 26.10.0 (observed unless marked) | SaaS sentry.io (docs / inference) |
|---|---|---|
| Base URL | One host, e.g. `http://localhost:9000`. `links.regionUrl` = `system.url-prefix` ([orgs-list.json](fixtures/orgs-list.json)) | `https://sentry.io` for control endpoints; data lives in a region. Use the region domain `us.sentry.io` or `de.sentry.io` so requests stay in the data region ([Data Storage Location](https://docs.sentry.io/organization/data-storage-location/)). Read `links.regionUrl` from `GET /api/0/organizations/` and use it for every org-scoped call (inference from the field) |
| Org subdomains | not used | `https://{org}.sentry.io` also works for the UI; API docs use `sentry.io/api/0/` |
| Single org | `SENTRY_SINGLE_ORGANIZATION = True` ([sentry.conf.example.py#L65](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py#L65)) | many orgs per token possible |
| API rate limits | **None**: middleware skips when `SENTRY_SELF_HOSTED` ([middleware/ratelimit.py#L119](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/middleware/ratelimit.py#L119)); no headers | Enforced per caller+endpoint with headers and 429 ([Rate Limits](https://docs.sentry.io/api/ratelimits/)); per-endpoint overrides in [auth-scopes-and-rate-limits.md](auth-scopes-and-rate-limits.md) |
| Feature flags | Set by `sentry.conf.py`. Feature-complete enables `organizations:session-replay`, `profiling`, `continuous-profiling`, `ourlogs-enabled` ([sentry.conf.example.py#L409-L432](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py#L409-L432)). Replay AI summaries off (403). `replay-details-eap-query` off | Flags vary by plan and rollout. Endpoints may switch backend (EAP) without notice. Treat experimental/private endpoints as liable to change |
| Retention | `SENTRY_EVENT_RETENTION_DAYS=90` ([.env#L6](https://github.com/getsentry/self-hosted/blob/26.10.0/.env#L6)); segment lookups are capped at 90 days in code anyway ([reader.py#L209-L215](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L209-L215)) | Plan-dependent ([data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)) |
| Webhooks to private IPs | Blocked by default (`SENTRY_DISALLOWED_IPS`), observed `restricted_ip` | Muninn must have a public HTTPS endpoint |
| Link header host | `system.url-prefix` (here `https://sentry.ouo.localhost`, not the host called) | `https://sentry.io` or region host |
| Response compression | nginx did not gzip API JSON (observed) | not checked |
| Code version | Pinned to the install's tag; read the source at that tag | Rolling deploys several times a day; public endpoints are versioned only by `publish_status` |
| Same endpoints | yes, same `getsentry/sentry` code | yes |

Org auth tokens contain the region URL in their payload (`sntrys_<base64 {iat,url,region_url,org}>_<secret>`, [orgauthtoken_token.py#L17-L34](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/utils/security/orgauthtoken_token.py#L17-L34)), so Muninn can derive the API host from such a token without asking the user.

**Muninn can use it for:** a per-connection `base_url` and `region_url` setting, a rate-limit-aware HTTP client that is a no-op on self-hosted, and a capability probe at connect time (try R1, R7 on one mobile segment, `/sessions/`) to learn which features are on.
