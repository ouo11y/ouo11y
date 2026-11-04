# 2026-11-04 F3: INP attribution with linked LoAF, slowest interactions by element

Client JUHI gap F3, roadmap WB3 part 1 (`project/kb/web-sdk-research/roadmap.md`). Branch
`claude/f3-inp`, one PR across SDK, rum-api, plugin and docs. Spec:
[docs/specs/web-vitals.md](../../../../docs/specs/web-vitals.md); kb:
[inp-attribution.md](../../../kb/inp-attribution.md).

## Done

- **SDK**: the INP `web_vital` event carries `ouo.web_vital.inp.*`:
  - the target is the click events' `app.widget.id`, never text; the browser's own
    `targetSelector` fallback is dropped;
  - type, the three phases, load state;
  - the longest LoAF script: invoker, invoker type, subpart, overlap, `code.file.path`,
    `code.function.name`, char position;
  - `app.screen.name` is stamped when INP changes.
- **Bundle**: web-vitals (attribution build) and the mapping are in the lazy chunk
  `dist/attribution-*.js` (5,924 B gzip, budget 6.0 KB). The core goes from 45,218 to 42,410 B; its
  budget line is unchanged, so it does not conflict with #159. `compat.mjs` has a source-map probe
  for the chunk. `elementId()` is split out of `describeElement()` and shared by clicks and INP.
- **rum-api**: `GET /v1/vitals/inp/targets`. The aggregation is in the new package
  `internal/vitals` (one value per page view, groups by target and page, nearest-rank p75,
  ratings, phase p75s, most frequent script); the handler is `httpapi/inp.go`; one route line.
- **Plugin**: the Performance page with "Slowest interactions by element"
  (`pages/Performance.tsx`, `components/SlowestInteractions.tsx`, `api/vitals.ts`); route,
  constant and nav entry.
- **Demo**: `verify.py` checks the visit's INP, attributed to `button.btn.chaos-btn` with its
  phases (and LoAF in Chromium), and checks the rum-api group for `/chaos`. README updated.
- **Docs**: new spec, docs index, session-lifecycle pointer, READMEs of browser, rum-api, plugin
  and demo; kb entry and index.

## Verified

Local runs, all on the founder's Mac at load averages of 200 to 1000 (other sessions' stacks):

- `sdk/browser`: vitest passed 205/205 on a quiet run (`test/vitals.test.ts` 7/7 on every run), plus
  tsc, `size:check` and `compat:check` (source-map probe for the new chunk).
  - Under load, the real-time integration tests (`interactions`, `replay-on-error`, `ssr`) fail
    with timeouts. In an A/B with main's sources restored, main's code failed and passed the same
    way.
- Playwright: Chromium passed 26/26, including CSP (the chunk loads under the strict policy) and
  the new "INP of a slow click" (`button#block`, phases, LoAF `BUTTON#block.onclick` in
  `processing-duration`). The new test also passed in Firefox and WebKit.
  - The full Firefox / WebKit runs at load ~900 failed 6 tests. They were 30 s timeouts in
    `page.evaluate` (Playwright Firefox on macOS 27 sandbox errors) and a rage click counting 3
    instead of 4: four sequential clicks stretched past the 1 s window. No SDK assertion failed.
- `services/rum-api`: `go vet ./...` and `go test ./...` passed, including the new
  `internal/vitals` and `httpapi/inp_test.go`.
- Plugin:
  - Jest: the new suites passed alone (10/10). In full runs, page suites (Funnels,
    SessionDetail, AppConfig, Performance) time out at random under load and pass alone.
  - tsc passed; eslint has 0 errors; prettier is clean on the touched files.
- `lychee --offline` reports 0 errors.
- Demo against the ouo-env `f3-inp`: the journey did not complete locally. rum-api and Grafana
  health checks timed out (3 s) under load, so Traefik routed nothing to them and the source-map
  upload got 404s. CI's examples job runs the same journey and verify, with the new INP checks,
  in three browsers.

## Dependencies

None added: `web-vitals/attribution` is a subpath of the existing `web-vitals` 6.2.3.

## Next agent

- LCP element / CLS largest-shift attribution can reuse the chunk: add the attributes in
  `inpAttributes`' siblings and keep the no-text rule (LCP's element through `elementId`).
- `browser.web_vital` names (N26) must dual-emit; rum-api's `internal/vitals` reads the Loki names
  from constants there.
- The chaos buttons share one target (`button.btn.chaos-btn`), because they have no id or test id
  and a `data-testid` would change their `app.widget.name`.
