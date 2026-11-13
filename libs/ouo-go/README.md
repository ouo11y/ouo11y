# ouo-go

Typed Go functions that read ouo's RUM data and apply Clearance to every result ([ADR-0023](../../docs/adr/0023-plugin-bff-and-clearance.md)). The Grafana plugin's backend (`plugins/ouo11y-rum-app/pkg`) is its first user; anyone building their own BFF can import it.

```go
c := &ouogo.Client{
	Loki:   &ouogo.Loki{URL: "http://loki:3100"},
	Muninn: &ouogo.Muninn{URL: "http://muninn:3400", Tenant: "anonymous", ReadToken: token},
	Tempo:  &ouogo.Tempo{URL: "http://tempo:3200"},                // optional: session traces
	Mimir:  &ouogo.Mimir{URL: "http://mimir:9009/prometheus"},     // optional: Home backend section
}
cl := ouogo.Resolve(cfg, user.Login, user.Role, teams) // the caller's Clearance level
list, err := c.ListSessions(ctx, cl, ouogo.SessionQuery{})
```

| Function | Needs | Returns |
|---|---|---|
| `ListSessions` | c1 | Sessions with records in the range, newest first; `User` from c4 |
| `GetSession` | c1 | Summary and event timeline; attributes and body from c2, identity attributes from c4, replays (from Muninn) from c3 |
| `GetManifest` | c3 | A replay's manifest (Muninn spec 7.2) |
| `GetChunk` | c3 | One chunk's bytes, decompressed |
| `GetOverview` | c1 | Session health, sessions over time, top errors (type and message from c2), web and mobile vitals from Loki; backend rate, errors, p95 from Mimir ([ADR-0025](../../docs/adr/0025-funnels-and-home-in-the-bff.md)) |
| `RunFunnel` | c1 | A funnel report over web and mobile sessions: per step sessions, platforms, conversion, drop-off, failed |
| `FunnelDropped` | c1 | The sessions that stopped before a step, failed or abandoned; `User` from c4 |
| `WalkFunnel`, `FunnelPaths`, `FunnelReportOf` | (pure) | The funnel rules on records you read yourself |

The levels are one table, `levels` in [clearance.go](clearance.go), tested field by field in `TestLevelsAgainstFields`. A user in neither the `users` nor the `roles` map gets level 0 and every read answers `ErrForbidden`.

Standard library only. `go vet ./... && go test ./...`. Licence Apache-2.0.
