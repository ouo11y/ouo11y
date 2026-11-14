# ouo-go

Typed Go readers for ouo11y's RUM data, for a client's own plugin backend or service ([ADR-0025](../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)): sessions and their events, funnels, session health % and mobile vitals from Loki, a session's traces from Tempo, replays from Muninn ([spec](../../docs/specs/muninn.md) section 7). The reads return the data as stored. Who may see what is the caller's decision: there is no user, role or level anywhere in this module.

```go
import (
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/redact"
)

loki := &ouogo.Loki{URL: "http://loki:3100"}
muninn := &ouogo.Muninn{URL: "http://muninn:3400", Tenant: "anonymous", ReadToken: token}
tempo := &ouogo.Tempo{URL: "http://tempo:3200"}

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
| `Loki.Health` | Session health % (ADR-0004): each session that started in the range is crashed (fatal exception, or `session.end` with reason `crash`), errored (any other exception, `http.request.failed`) or healthy; counts and percentages per platform, service and version, and in total. Records are read from 4 hours (`Lookback`) before the range so a session that started just before it is left out whole; `Truncated` at 100,000 records |
| `Loki.SessionVitals` | A session's mobile vitals ([spec](../../docs/specs/mobile-vitals.md)): each `ouo.app.start`, `ouo.screen.display`, `app.jank` and `ouo.stall` record with its values and rating, and the summary (app start, screens, TTID p50 and max, frames, stalls). A session without vitals answers an empty list |
| `Tempo.SessionTraces` | The traces with a span of the session (`span.session.id`), newest first: root name and service, start, duration, span count, error, and the root's `url.path` for generic `HTTP GET` roots. `TraceWindow(session)` is the range to search: the session's records widened by 2 minutes |
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

## Install from a client repository

`ouo11y/ouo11y` is private, so the public Go module proxy and checksum database cannot fetch `github.com/ouo11y/ouo11y/libs/ouo-go`: without the setting below `go get` ends with `could not read Username for 'https://github.com'`. Releases are tags `libs/ouo-go/vX.Y.Z`; ask for the version, not the tag:

```bash
go env -w GOPRIVATE='github.com/ouo11y/*'    # fetch straight from GitHub, skip the public checksum database
go get github.com/ouo11y/ouo11y/libs/ouo-go@v0.1.0
```

**Locally**, git needs credentials for `https://github.com` with read access to `ouo11y/ouo11y`. With the GitHub CLI: `gh auth login`, then `gh auth setup-git`. Without it, a fine-grained token with *Contents: read* on `ouo11y/ouo11y` in your git credential helper, or `git config --global url."https://x-access-token:<token>@github.com/ouo11y/".insteadOf "https://github.com/ouo11y/"`.

**In GitHub Actions** (for example in `ouo11y/clients`), the job's own `GITHUB_TOKEN` reads only its own repository. Store a fine-grained token (or a GitHub App installation token) with *Contents: read* on `ouo11y/ouo11y` as a secret, here `OUO11Y_READ_TOKEN`, and point git at it before anything runs `go`:

```yaml
env:
  GOPRIVATE: github.com/ouo11y/*
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-go@v6
    with: { go-version-file: go.mod }
  - run: git config --global url."https://x-access-token:${{ secrets.OUO11Y_READ_TOKEN }}@github.com/ouo11y/".insteadOf "https://github.com/ouo11y/"
  - run: go build ./... && go test ./...
```

A Docker build needs the same: pass the token as a build secret (`RUN --mount=type=secret,id=gh ...`), never as a build argument or a layer. Once `ouo11y/ouo11y` is public, `GOPRIVATE` and the token can go.

## Build

Dependency: `github.com/go-jose/go-jose/v4` (JWS and JWKS, `oidc` only); everything else is the standard library. `go vet ./... && go test ./...`. Licence Apache-2.0.
