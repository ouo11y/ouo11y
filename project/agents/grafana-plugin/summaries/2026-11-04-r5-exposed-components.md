# R5: exposed components for embedding ouo in host plugins (2026-11-04)

Branch `claude/r5-exposed-components`, PR #165. JUHI gap R5: the customer's own Grafana app plugin shows ouo's session and replay views inside its pages.

## What was done

- **Three exposed components**, declared in `plugin.json` `extensions.exposedComponents` and registered in `module.tsx` via `src/exposed/register.ts`:
  - `ouo11y-rum-app/session-detail/v1`: `sessionId`, `timeRange`, `project`, `app`.
  - `ouo11y-rum-app/sessions-list/v1`: the above plus `filters`, `limit`, `onSessionClick`.
  - `ouo11y-rum-app/overview-health/v1`: `timeRange`, `project`, `app`.

  The props types are in `src/exposed/types.ts`.
- **The pages are reused, not copied:**
  - `src/embed/EmbedContext.ts` carries a query built from props (`EmbedRoot.embedSearch`). `useSearchParams` returns it when embedded, so `useRawRange` and, after #162, `useScope` read the props. The host's URL is never read or written.
  - `components/PageShell.tsx` stands in for `PluginPage` in Overview and SessionDetail: when embedded it renders only the children.
  - `SessionDetail` takes an optional `sessionId` prop, because a host route's `useParams` belongs to the host.
  - The sessions list is a new small component (`src/exposed/SessionsList.tsx`) that reuses `SessionsTable`. The Sessions page keeps its filter UI in ouo's URL, while a host owns its own filter UI.
- **Feature toggles** come from `usePluginContext()` (ouo's settings: Grafana wraps exposed components in the provider's context).
- **Bundle size.** The pages lazy-load, so `module.js` stays at 9.6 KB.
- **Docs:**
  - ADR-0019 (0018 is taken by #159);
  - `docs/embedding.md`, including link-out as the bridge;
  - kb `project/kb/grafana-exposed-components.md`;
  - the plugin README, `deploy/README.md`, and the index files.
- **Fixture.** `examples/embed-host-plugin` is a no-build AMD host plugin, `autoEnabled`. `deploy/compose/compose.embed-host.yaml` mounts it and extends the unsigned and sandbox lists. It is opt-in only.

## Verified, and how

- Jest: 18 new tests in `src/exposed/`. The full plugin suite is 226 tests; two existing suites timed out once under host load and passed when rerun on their own.
- eslint: 0 errors. tsc: clean. Webpack production build: compiles. CI on the PR: green.
- Live: compose project `r5embed` (ports 25500-25512) with the override, data from `e2e.sh`. A Playwright run on the host page passed 10 of 10 checks:
  - the three components render;
  - only the host's page header is drawn;
  - `onSessionClick` mounts the detail;
  - the rrweb player iframe, activity list, traces and logs render;
  - 12 of 12 rum-api calls go through `/api/plugin-proxy/ouo11y-rum-app/rum/`;
  - no console errors.

  Report: `project/agents/grafana-plugin/reports/r5-exposed-components.html`.

## Dependencies

None added.

## Left / next agent

- Merge `origin/main` once #162 (R1 scope selector) lands. Check that `useScope` picks up `project` and `service` from the embed query. Check that #162's Overview and Sessions changes still sit inside `PageShell` (ScopePicker should be in `actions`, which embedded mode drops).
- Not exposed: funnels. A host links out to them (documented).
- Shell quirk: npm inside these worktrees walks up into the shared checkout's conflicted `package.json`. Use `npm --prefix "$PWD"` at the worktree root, or `node_modules/.bin/*`.
