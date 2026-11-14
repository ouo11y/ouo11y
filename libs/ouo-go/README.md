# ouo-go

Typed Go readers for ouo11y's RUM data, for a client's own plugin backend or service ([ADR-0025](../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)): sessions and their events, funnels, session health % and mobile vitals from Loki, a session's traces from Tempo, replays from Muninn ([spec](../../docs/specs/muninn.md) section 7). The reads return the data as stored. Who may see what is the caller's decision: there is no user, role or level anywhere in this module.

```go
import (
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/redact"
)

loki := &ouogo.Loki{URL: "http://loki:3100"}
muninn := &ouogo.Muninn{URL: "http://muninn:3400", Tenant: "anonymous", ReadToken: token}
tempo := &ouogo.Tempo{URL: "http://tempo:3200"} // Token: a bearer, when Tempo needs one

list, err := loki.ListSessions(ctx, ouogo.SessionQuery{Project: "shop"})
s, err := loki.SessionEvents(ctx, "shop", sessionID, ouogo.TimeRange{})
replays, err := muninn.ListReplays(ctx, "shop", sessionID)
m, err := muninn.Manifest(ctx, "shop", sessionID, replayID)
chunk, err := muninn.Chunk(ctx, "shop", sessionID, replayID, streamID, 0)

steps, err := ouogo.ParseFunnelSteps("page:/,page:/products/*,event:add_to_cart")
funnel, err := loki.Funnel(ctx, ouogo.FunnelQuery{Steps: steps, Filters: ouogo.Filters{Project: "shop"}})
health, err := loki.Health(ctx, ouogo.HealthQuery{Filters: ouogo.Filters{Project: "shop"}})
vitals, err := loki.SessionVitals(ctx, "shop", sessionID, ouogo.TimeRange{})
traces, err := tempo.SessionTraces(ctx, sessionID, ouogo.TraceWindow(s.Session))

// Optional: your access model, e.g. no identity for this user.
redact.Sessions(list.Sessions, redact.Identity)
redact.Session(&s.Session, redact.Identity)
redact.Events(s.Events, redact.Identity)
redact.Manifest(m, redact.Identity)
```

| Read | Returns |
|---|---|
| `Loki.ListSessions` | Sessions with records in the range (default the last 24 hours, at most 30 days), newest first, with counts, a replay hint and the user (`enduser.id`, else the Sentry bridge's `user.id`); `Truncated` when the read hit `ListLimit` (5000 records) or the query's `Limit` |
| `Loki.SessionEvents` | One session's summary and its events, oldest first: name, severity, view, trace and span ids as fields, every other label as an attribute (`.` written `_`), and the body; `Truncated` at `EventLimit` (5000); `ErrNotFound` when Loki has no record of it |
| `Loki.Funnel`, `Loki.FunnelDropped`, `Loki.FunnelSteps` | How many sessions reached each of 2 to 10 ordered steps (a page path or a custom event), the sessions that stopped at a step, and the paths and event names seen, for a step picker: [funnels.md](funnels.md), [spec](../../docs/specs/funnels.md) |
| `Loki.Health` | Session health % (ADR-0004): each session that started in the range is crashed (fatal exception, or `session.end` with reason `crash`), errored (any other exception, `http.request.failed`) or healthy; counts and percentages per platform, service and version, and in total. Records are read from 4 hours (`Lookback`) before the range so a session that started just before it is left out whole; replay chunk references are not read; `Truncated` at 100,000 records. The `Platform` filter matches the `ouo_platform` label, which web SDK 0.4 sessions do not carry: filtered by platform, they are left out |
| `Loki.SessionVitals` | A session's mobile vitals ([spec](../../docs/specs/mobile-vitals.md)): each `ouo.app.start`, `ouo.screen.display`, `app.jank` and `ouo.stall` record with its values and rating, and the summary (app start, screens, TTID p50 and max, frames, stalls). A session without vitals answers an empty list |
| `Tempo.SessionTraces` | The traces with a span of the session (`span.session.id`), newest first: root name and service, start, duration, span count, error, and the root's `url.path` for generic `HTTP GET` roots. `TraceWindow(session)` is the range to search: the session's records widened by 2 minutes. Tempo is searched by session id alone, in every project: a caller that scopes by project checks the session's project first (`Loki.SessionEvents`). `Token` is sent as a bearer when Tempo sits behind an authenticating proxy |
| `Loki.QueryRange`, `Loki.QueryVector` | Raw LogQL reads, for queries of your own (a range limit of 0 means 5000); build them from validated values only |
| `Muninn.ListReplays` | A session's replays (spec 7.1) |
| `Muninn.Manifest` | A replay's manifest (spec 7.2) without Muninn's chunk paths. Chunk `Attributes` are every stored attribute (MUN-6) and may carry identity |
| `Muninn.Chunk` | One chunk's bytes, decompressed, and its format id |

Readers with a nil `HTTP` use a client with a 30 second timeout. Every identifier is checked before it reaches LogQL, TraceQL or a Muninn path (project `^[a-z0-9][a-z0-9._-]{0,63}$`, ids 32 lowercase hex, filter values `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`, funnel step values without control characters, quotes, backslashes or backticks): a bad one is a `*BadRequestError` and no store is called. A store failure is a `*BackendError`: log `Error()` (it carries URLs and queries), show users `Public()`.

The funnel, health, vitals and traces readers are ported from rum-api with its tests and give its answers on the same data; [funnels.md](funnels.md#compared-with-rum-api) lists where they differ and why (mainly: rum-api does not read the web SDK 0.4 wire). Health and traces differ in two small fixes: `Health` takes a `project` filter, and a trace whose `serviceStats` count an error keeps `HasError` when the error span has no `session.id` (rum-api dropped it).

Optional sub-packages, which decide nothing for you:

| Package | What |
|---|---|
| `redact` | `Identity` (`enduser.*`, `user.id`, `user.email`, `user.name`, `user.full_name`, `user.hash`, `user.roles`, `client.address`, in both the `.` and Loki's `_` spelling), matchers `Keys`, `Prefixes`, `Any`, and filters `Drop`, `Keep` (an allow list), `Session` and `Sessions` (clear `User`), `Events`, `Manifest`: with `Identity` they cover everything the readers return. It does not look inside values |
| `oidc` | `Verifier.Verify` checks an OpenID Connect ID token (signature against the provider's JWKS, asymmetric algorithms only, issuer, audience, expiry) and returns its claims; `Groups` returns the groups claim. Keys are cached, refetched for an unknown key id at most once a minute (also when the provider is down) and dropped after an hour. It does not bind a token to the caller: see [the kb](../../project/kb/plugin/idp-tokens/idp-tokens-in-a-plugin-backend.md), which also says how a Grafana plugin backend receives the token at all |

## Install

`ouo11y/ouo11y` is public, so the Go module proxy serves `ouo-go` like any other module: no `GOPRIVATE`, no git credentials, no token in CI. Releases are tags `libs/ouo-go/vX.Y.Z`; ask for the version, not the tag:

```bash
go get github.com/ouo11y/ouo11y/libs/ouo-go@v0.1.0
```

## Build

Dependency: `github.com/go-jose/go-jose/v4` (JWS and JWKS, `oidc` only); everything else is the standard library. `go vet ./... && go test ./...`. Licence Apache-2.0.
