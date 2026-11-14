# 2026-11-14 rum-api's read features as ouo-go readers

Branch `claude/ouo-go-readers-54e454`, cut from `origin/main` at `94eaf46d`. Decision: [ADR-0025 amendment 1](../../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md#amendments). Asked by the session that runs the rum-api retirement (founder decision of 2026-11-14: funnels, health %, vitals and traces per session become `ouo-go` readers because their definitions follow our telemetry schema).

## What was done

- **`libs/ouo-go` readers**, ported from rum-api with its tests, in the style of `Loki.ListSessions` (no users or levels, identifiers checked before any query, `*BackendError` with `Public()` for store failures):
  - `funnel.go`: `Loki.Funnel`, `Loki.FunnelDropped`, `Loki.FunnelSteps`, `ParseFunnelStep(s)`, `FunnelStep.String`, `Filters` (project, service, environment, release, platform). Same walk (strict order, every start tried, deepest wins), same report (conversion to 2 decimals, nearest-rank median and p75), same drop-off order, same paged Loki read (5,000 per page, 100,000 per step kind).
  - `health.go`: `Loki.Health`. Same ADR-0004 classification, same start-of-session rule (`session.start`, SDK `ouo.session.started_at`, `session.end` fallback), same 4 h lookback, same buckets and rounding.
  - `vitals.go`: `Loki.SessionVitals`. Same values, ratings and summary (mobile vitals spec section 4 and 7).
  - `tempo.go`: `Tempo` reader type, `Tempo.SessionTraces`, `TraceWindow`. Same three TraceQL searches (traces, `status = error`, root `url.path` for generic `HTTP GET` roots); no Grafana Explore link (a client's UI builds its own).
  - `loki.go`: `QueryVector` now shares an internal `queryVector` that also returns values; `Loki.FunnelEventLimit`.
- **Tests** (`readers_test.go`, 18 tests, table tests against fake Loki and Tempo): rum-api's funnel, classify, health, ratings, vitals and Tempo tests ported; rum-api's Loki fixtures copied to `testdata/`; new: both wires, the LogQL and TraceQL sent, paging, validation before any request (12 cases), store errors kept out of `Public()` for all six readers, best-effort Tempo searches.
- **Docs**: `docs/funnels.md` moved to [libs/ouo-go/funnels.md](../../../../libs/ouo-go/funnels.md) (rewritten for the readers, with a "Compared with rum-api" table); links in `docs/index.md`, the checklist, the plugin README and the tiny-shop guide repointed. `docs/specs/funnels.md` kept and updated (both wires, users, 30-day range, no cache, new LogQL, API). `libs/ouo-go/README.md`: the new readers, the validation rules, and **Install from a client repository** (`GOPRIVATE`, local git credentials, a token in GitHub Actions, Docker build secret).
- **ADR-0025** amended: the decision row lists the new readers; "the existing plugin stays as on `main`" became "the MVP plugin is deleted with `services/rum-api` once ADR-0026 and these readers are released"; `ouo-go` is released by tag and installed with `GOPRIVATE`; an Amendments section. Status left for the founder.
- **kb** `project/kb/plugin/ouo-go/`: `two-rum-wires-in-loki.md`, `private-go-module.md`.

## rum-api bugs found, fixed in the port with a test

1. **Funnels do not read the web SDK 0.4 wire.** Since `@ouo11y/browser` 0.4.0 (ADR-0020) a page change is `browser.navigation` with `url.full`, the user is `enduser.id`, and custom events carry no `ouo.event.custom`. rum-api matches `navigation` + `url_path`, counts `user_id` and suggests only marked events, so every web page step counts 0 sessions. The readers match both wires (`TestFunnelWalkStrictOrder` "web SDK 0.4 wire", `TestFunnelReportAndDropped` session c, `TestFunnelSteps`).
2. **`/v1/funnels/steps` (and the other handlers) put the Loki error text in the answer** (`"loki: " + err.Error()`). The readers return `*BackendError` (`TestReadersKeepStoreErrorsOut`).
3. **Step values and filters went into LogQL unchecked** (only `strconv.Quote`d). The readers reject control characters, quotes, backslashes and backticks in step values and check filters against `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` (`TestReadersRejectBeforeQuerying`).
4. **Tempo `has_error` was overwritten** by the `status = error` search, which only finds error spans that carry `session.id`; a backend error counted in `serviceStats` was lost. The readers keep either (`TestTempoSessionTraces`, trace `ccc`).

Deliberate differences: 30-day ranges (every `ouo-go` read; rum-api 31), no 10 s rounding and no cache (the caller caches), `Truncated` where rum-api truncated silently, no `has_replay` on dropped sessions (Muninn answers that), `Health` and the funnel take a `project` filter, vitals of an unknown session answer an empty list instead of 404 (one Loki query instead of two; `SessionEvents` tells them apart), `SessionVitals` and `SessionTraces` take the caller's range (`TraceWindow(session)` gives rum-api's).

## Verified, and how

- `cd libs/ouo-go && go vet ./... && go test -count=1 ./...`: ok (ouo-go, oidc, redact).
- `lychee --offline --no-progress --exclude-path node_modules --exclude-path /dist/ './**/*.md' './**/*.html'`: 0 errors.
- **`go get` from a client module** (throwaway module in the scratchpad, fresh `GOMODCACHE`): without `GOPRIVATE` it fails after more than two minutes with `could not read Username for 'https://github.com': terminal prompts disabled`; with `GOPRIVATE='github.com/ouo11y/*'` it adds `github.com/ouo11y/ouo11y/libs/ouo-go v0.1.0` and a `main.go` importing `ouogo` builds and runs. The GitHub Actions recipe in the README is not run in CI (no client repository yet).
- **Live comparison with rum-api** on env `ouo-go-readers` (`deploy/envs/ouo-env up ouo-go-readers`, this branch's images). Data: three `examples/ouo-web/scripts/run.sh --env ouo-go-readers` journeys (web SDK 0.4.1; sessions `d2c70311…`, `f1b23d3e…`, `6267100d…`) and two mobile-wire sessions posted as OTLP JSON to the env's collector (`aaaa0000…0001`: app start, two screens, jank, stall, `navigation` + `url.path`, `add_to_cart` with `ouo.event.custom`, `http.request.failed`; `bbbb0000…0002`: fatal exception and `session.end` reason `crash`). A Go program called each reader and the matching rum-api route (read token `rt_dev_…`) over the same last hour:
  - Health (`Loki.Health` vs `GET /v1/stats/health`): **equal**. web-store 1.4.2: 3 sessions, 3 errored (the journey's render error); mobile-store 9.9.9: 2 sessions, 1 errored, 1 crashed; totals 5 / 80 % errored / 20 % crashed.
  - Vitals (`Loki.SessionVitals` vs `GET /v1/sessions/{id}/vitals`), all 5 sessions: **equal** (summary and every record; the mobile session: cold app start 3060.7 ms needs-improvement, 2 screens, TTID p50 1863.2 max 3316.2, frames 120/4/1, stalls 2/340/220).
  - Traces (`Tempo.SessionTraces(TraceWindow)` vs `GET /v1/sessions/{id}/traces`): **equal** for the 3 web sessions (14 traces each: id, root name, span count, error, root path); none for the mobile ones on both.
  - Funnel `page:/ → page:/products/* → event:add_to_cart → event:checkout_submitted`, platform `mobile`: **equal**. All platforms: **differs as expected**: ouo-go 5 / 4 / 4 / 3 sessions, rum-api 2 / 1 / 1 / 0, the difference being exactly the 3 web sessions rum-api cannot see (bug 1).
  - Drop-offs at step 3: 0 on both. Step suggestions: ouo-go lists the web paths (`/`, `/cart`, `/checkout`, `/products/p-100x`, …) and `add_to_cart`, `checkout_submitted`; rum-api lists only the mobile session's `/`, `/products/p-1001` and `add_to_cart` (bug 1).

## Also checked, not built

- **`POST /v1/admin/retention/sweep`**: covered by Muninn. rum-api's sweep runs one pass of its own replay-store sweeper (`services/rum-api/internal/httpapi/admin.go:149-161` → `internal/lifecycle/sweeper.go:79-118`, which only lists and deletes replays in rum-api's store). Muninn has the same retention for its replays (`docs/specs/muninn.md:378-380`, MUN-50 to MUN-52), run every `retention.sweep_interval` by `RunSweeper` (`services/muninn/internal/muninn/read.go:520`, `:582`, started in `services/muninn/main.go:94`). What has no equivalent is the on-demand trigger: Muninn's routes (`server.go:78-86`) have no sweep endpoint. Loki retention (`deploy/compose/loki/config.yaml:38-46`) is unrelated: rum-api's sweep never touched Loki. (rum-api's README says the sweeper also expires source maps, `README.md:511`; that is ADR-0026's debug-file topic.)
- **`DELETE /v1/sessions/{id}/replay`**: not by `ouo-erase` as a command. On branch `claude/rum-api-leftovers-33b874`, `ouo-erase` has `user`, `project` and `audit` only (`libs/ouo-go/cmd/ouo-erase/main.go:1-12`); it deletes per-session replays only inside `user` (`libs/ouo-go/erase/erase.go:261-297`, via `Muninn.DeleteSessionReplays`, `libs/ouo-go/muninn_admin.go:99`). Deleting one session's replays is Muninn's own API, `DELETE /api/v1/projects/{p}/sessions/{s}/replays` (`services/muninn/internal/muninn/server.go:83`, spec section 8, MUN-40/41 at `docs/specs/muninn.md:363-364`), which `Muninn.DeleteSessionReplays` calls. So the route is covered by Muninn plus that library call; if an operator needs it from the command line, `ouo-erase session <project> <id>` is a small addition on that branch.

## What the next agent must know

- **Overlap with the ADR-0026 branch** (`claude/rum-api-leftovers-33b874`, not merged): it also edits `libs/ouo-go/README.md`, `docs/adr/README.md` and `project/kb/index.md`, and has its own `erase.Tempo` with `TraceIDs`. Whichever merges second rebases those files; afterwards `erase` can use `ouogo.Tempo` instead of its own type.
- rum-api's handlers also served the plugin's session list and detail; those are `Loki.ListSessions` / `SessionEvents` already. The plugin and rum-api can go once ADR-0026 and this PR are merged and released (`libs/ouo-go/v0.2.0`).
- No dependency added.
- Env `ouo-go-readers` is **still running** for the reviewer: http://grafana.ouo-go-readers.ouo.localhost (admin / testing567), Loki http://loki.ouo-go-readers.ouo.localhost, rum-api http://rum-api.ouo-go-readers.ouo.localhost. Tear it down with `deploy/envs/ouo-env down ouo-go-readers` once the review is done (`ouo-env gc` also takes it once the PR closes).
- Not done: the reviewer session (ADR-0013) could not be started from this session (the app only starts sessions on the user's own words); it is proposed as a card. No `Review:` / `Author:` comments on the PR yet.

## Review round 1 (session review-196, `Review: changes needed`)

- **Fixed** `Loki.Health` read every `ouo.replay.chunk` record (most of a replayed session's records) into the 100,000 limit: it now excludes them with the same `replaySelector` as `ListSessions` (`Filters.selector` takes extra matchers); `TestHealthReader` asserts the LogQL. Re-run live: Health still equal to rum-api (5 sessions), and Loki accepts the double `event_name` matcher.
- **Fixed** `Tempo` gets `Token` (bearer) and trims a trailing `/` on `URL`, so `erase` on the ADR-0026 branch can reuse `ouogo.Tempo`; tested.
- **Fixed** README Actions example: the token goes to git through step-scoped `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` instead of `git config --global` (persistent self-hosted runners keep the home directory); the client repository is no longer named. kb `private-go-module.md` updated.
- **Fixed** README and the `SessionTraces` doc: Tempo is searched by session id alone, so a caller that scopes by project checks the session's project first.
- **Fixed** README and `funnels.md`: the `Platform` filter misses web SDK 0.4 sessions (no `ouo_platform` label).
