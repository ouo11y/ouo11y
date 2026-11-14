# ouo-go

Typed Go readers for ouo11y's RUM data, for a client's own plugin backend or service ([ADR-0025](../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)): sessions and their events from Loki (the client SDK spec's wire), replays from Muninn ([spec](../../docs/specs/muninn.md) section 7). The reads return the data as stored. Who may see what is the caller's decision: there is no user, role or level anywhere in this module.

```go
import (
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/redact"
)

loki := &ouogo.Loki{URL: "http://loki:3100"}
muninn := &ouogo.Muninn{URL: "http://muninn:3400", Tenant: "anonymous", ReadToken: token}

list, err := loki.ListSessions(ctx, ouogo.SessionQuery{Project: "shop"})
s, err := loki.SessionEvents(ctx, "shop", sessionID, ouogo.TimeRange{})
replays, err := muninn.ListReplays(ctx, "shop", sessionID)
m, err := muninn.Manifest(ctx, "shop", sessionID, replayID)
chunk, err := muninn.Chunk(ctx, "shop", sessionID, replayID, streamID, 0)

// Optional: your access model, e.g. no identity for this user.
redact.Events(s.Events, redact.Identity)
redact.Manifest(m, redact.Identity)
s.Session.User = ""
```

| Read | Returns |
|---|---|
| `Loki.ListSessions` | Sessions with records in the range (default the last 24 hours, at most 30 days), newest first, with counts, a replay hint and the user (`enduser.id`, else the Sentry bridge's `user.id`); `Truncated` when the read hit `ListLimit` (5000 records) or the query's `Limit` |
| `Loki.SessionEvents` | One session's summary and its events, oldest first: name, severity, view, trace and span ids as fields, every other label as an attribute (`.` written `_`), and the body; `Truncated` at `EventLimit` (5000); `ErrNotFound` when Loki has no record of it |
| `Loki.QueryRange`, `Loki.QueryVector` | Raw LogQL reads, for queries of your own; build them from validated values only |
| `Muninn.ListReplays` | A session's replays (spec 7.1) |
| `Muninn.Manifest` | A replay's manifest (spec 7.2) without Muninn's chunk paths. Chunk `Attributes` are every stored attribute (MUN-6) and may carry identity |
| `Muninn.Chunk` | One chunk's bytes, decompressed, and its format id |

Every identifier is checked before it reaches LogQL or a Muninn path (project `^[a-z0-9][a-z0-9._-]{0,63}$`, ids 32 lowercase hex): a bad one is a `*BadRequestError` and no store is called. A store failure is a `*BackendError`: log `Error()` (it carries URLs and queries), show users `Public()`.

Optional sub-packages, which decide nothing for you:

| Package | What |
|---|---|
| `redact` | `Identity` (`enduser.*`, `user.id`, `user.email`, `user.name`, `user.full_name`, `user.hash`, `user.roles`, `client.address`, in both the `.` and Loki's `_` spelling), matchers `Keys`, `Prefixes`, `Any`, and filters `Drop`, `Keep` (an allow list), `Events`, `Manifest`. It does not look inside values |
| `oidc` | `Verifier.Verify` checks an OpenID Connect ID token (signature against the provider's JWKS, asymmetric algorithms only, issuer, audience, expiry) and returns its claims; `Groups` returns the groups claim. Keys are cached, refetched for an unknown key id at most once a minute (also when the provider is down) and dropped after an hour. It does not bind a token to the caller: see [the kb](../../project/kb/plugin/idp-tokens/idp-tokens-in-a-plugin-backend.md), which also says how a Grafana plugin backend receives the token at all |

Dependency: `github.com/go-jose/go-jose/v4` (JWS and JWKS, `oidc` only); everything else is the standard library. `go vet ./... && go test ./...`. Licence Apache-2.0.
