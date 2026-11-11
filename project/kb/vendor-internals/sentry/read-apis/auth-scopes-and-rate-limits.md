# Auth, scopes and rate limits for Sentry's read API

> Which token should Muninn use, which scopes does each read need, and how fast may it call?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10.

## Token kinds

| Kind | How made | Bound to | Header | Notes |
|---|---|---|---|---|
| User auth token | User settings, or `ApiToken` | A user; sees that user's member projects by default | `Authorization: Bearer <token>` | Dies with the user |
| Internal integration token | Org settings → Custom Integrations → internal, or `POST /api/0/sentry-apps/` with `isInternal:true`; token via the app's token list | A proxy user of the Sentry App; sees **all** projects | Bearer | **Recommended for Muninn**: org-owned, scoped, can also receive webhooks. [Docs](https://docs.sentry.io/organization/integrations/integration-platform/internal-integration/), accessed 2026-11-10 |
| Org auth token (`sntrys_…`) | Org settings → Auth Tokens (UI only offers `org:ci`) | The org, no user | Bearer | Sees **no projects unless `project=-1`** or explicit ids (observed). Meant for CI |

Docs: [Authentication](https://docs.sentry.io/api/auth/), [Permissions & Scopes](https://docs.sentry.io/api/permissions/) (accessed 2026-11-10).

## Scope matrix (observed)

Nine tokens were minted on 2026-11-10 (five user tokens and three org tokens via `sentry exec` in `sentry-sbx-web-1`, one internal integration via the API) and called against 30 GET endpoints. Raw results: [scope-matrix.json](fixtures/measurements/scope-matrix.json). Script: [scripts/scope_matrix.py](scripts/scope_matrix.py).

| Endpoint group | Scope that passed (user token) | Failed with |
|---|---|---|
| orgs, org details, project list, replays list (R1), replay details (R2), replay-count, replay-selectors, `/sessions/`, Discover/Explore `/events/` (errors, spans, logs), `/trace/`, `/trace-meta/`, `eventids`, org tag values | `org:read` | 403 for `project:read`-only and `event:read`-only tokens |
| project keys, project replay details (R3), recording segments (R4/R5/R6), video (R7), clicks (R8), project event details, event attachments, project users, releases | `project:read` | 403 for `org:read`-only |
| issues list, issue details, issue events, latest event, replay viewed-by | `event:read` | 403 for `org:read`-only |
| replay summarize | none (feature off on self-hosted) | 403 for all |

So **Muninn needs `org:read`, `project:read` and `event:read`**. The three-scope user token, the three-scope org token and the internal integration with the same scopes passed every endpoint (except `summarize`). An org token with only `org:read event:read` failed project endpoints. A `team:read` token and an `org:ci` org token failed everything except `releases` (org:ci).

Scope maps per HTTP method come from the permission classes, e.g. `OrganizationPermission` GET = `org:read|org:write|org:admin`, `ProjectPermission` GET = `project:read|write|admin`, `GroupPermission`/`OrganizationEventPermission` GET = `event:read|write|admin` ([routes-26.10.0.json](fixtures/measurements/routes-26.10.0.json)).

### The extra replay gate

`has_replay_permission` runs after the scope check on every replay endpoint ([replays/permissions.py#L18-L60](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/permissions.py#L18-L60)):

1. Superusers pass.
2. If the org option `sentry:granular-replay-permissions` is off (the default), everyone with the scope passes.
3. Org auth tokens with `event:read` pass.
4. Sentry App proxy users (internal integrations) whose app has `event:read` pass.
5. Otherwise the user must be on the `OrganizationMemberReplayAccess` allowlist; an empty allowlist means nobody.

Consequence: with granular replay permissions on, a **user token stops working** for replays unless that user is allowlisted, while an internal integration with `event:read` keeps working. Rule 2 was observed (option off locally); rules 3–5 are from source only.

### Default project selection

Org-level endpoints without `project=` use the caller's member projects ([api/bases/organization.py#L405-L475](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/bases/organization.py#L405-L475)). Observed: the org token got `{"data":[]}` from replays, events and issues, and 400 "No projects available" from `/sessions/`, until `project=-1` was added. **Muninn should always send `project=-1` or explicit ids.**

## Rate limits

How they work on SaaS ([docs](https://docs.sentry.io/api/ratelimits/), accessed 2026-11-10): per caller and endpoint, a fixed window plus a concurrency cap; headers `X-Sentry-Rate-Limit-Limit`, `-Remaining`, `-Reset`, `-ConcurrentLimit`, `-ConcurrentRemaining`; HTTP 429 when exceeded.

Per-endpoint values from source (`rate_limits = RateLimitConfig(...)`, per category IP / user / org; `[limit, window s, concurrent]`):

| Endpoint | GET limit | Enforced flag in class |
|---|---|---|
| `organizations/{org}/events/` and `events-timeseries/` | 30/1 s, 15 concurrent | yes |
| `organizations/{org}/issues/` | IP/user 10/1 s, org 20/1 s | yes |
| `issues/{id}/` | 5/1 s | yes |
| `issues/{id}/events/{event}/` | 15/1 s | yes |
| `projects/{org}/{proj}/events/` | 60/60 s, 1 concurrent (org 2) | yes |
| `projects/{org}/{proj}/events/{id}/` | 5/1 s | no (default enforcement) |
| `organizations/{org}/eventids/{id}/` | **1/1 s** | yes |
| `organizations/{org}/replay-count/` | 20/1 s | yes |
| `projects/{org}/{proj}/tags/{key}/values/` | 10/1 s (org 20, 5 concurrent) | yes |
| `projects/{org}/{proj}/users/` | org 5/60 s | no |
| `organizations/{org}/releases/`, `projects/.../keys/`, `members/` | 40/1 s | no |
| replays list, details, segments, video, `/sessions/`, `/trace/` | no override: group default | no |

All values: [routes-26.10.0.json](fixtures/measurements/routes-26.10.0.json). Default when no override: `SENTRY_RATELIMITER_DEFAULT = 999` per second ([conf/server.py#L1741-L1750](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/conf/server.py#L1741-L1750)); SaaS overrides settings we cannot see, so read the headers.

**Self-hosted does not rate limit the API at all.** The middleware returns early when `SENTRY_SELF_HOSTED` ([middleware/ratelimit.py#L119](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/middleware/ratelimit.py#L119)), and `enforce_rate_limit` defaults to `SENTRY_RATELIMITER_ENABLED = False` ([api/base.py#L271-L272](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/base.py#L271-L272)). Observed: no `X-Sentry-Rate-Limit-*` header on any response, including enforced endpoints like `/issues/`. Muninn must still pace itself against self-hosted (it shares Postgres/ClickHouse with the customer's UI) and must honour headers and 429 + `Retry-After` on SaaS.

Pacing suggestion for Muninn: one replay list call per project group per poll; segment downloads at most ~10 in flight (Sentry itself uses 10 threads per R4 page); `eventids` never in a loop.

## Tokens created for this research

All were created on 2026-11-10 and revoked at the end of the run (see the summary): user tokens ids 10–14, org auth tokens ids 1–3, internal integration `step6-read-api-muninn-probe-*` (token id 15). Values were never written to the repo.
