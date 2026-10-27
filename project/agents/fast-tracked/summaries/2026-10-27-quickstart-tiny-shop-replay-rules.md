# 2026-10-27: tiny-shop-replay, brought in line with the quickstart rules (N54)

PR #68 (`examples/quickstarts/tiny-shop-replay`) checked rule by rule against
`examples/quickstarts/index.md`, "Rules for every quickstart", with tiny-shop-otel as the reference.

## What was done

- **Rebased on `main`** as one commit (the branch had a merge commit from `main`). Kept main's
  quickstart README and index, and re-added this quickstart's rows: README table, index table,
  "Where each quickstart stands", the fast-tracked tracker and the kb index.
- **Renumbered** in the checklist: the branch's N43 / N44 / N45 are taken on `main` by web-SDK
  items. The quickstart is now **N54**. The old N44 (mask by CSS selector) is dropped because
  `@ouo11y/browser` 0.3.0 has `replay.blockSelector` and `maskTextSelector`. The old N45
  (`captureError` without a trace id) is **N55**; it still happens on 0.3.0. New: **N56**, the SDK
  depends on deprecated OpenTelemetry 2.x browser packages. **N57**, the SDK's event log lines have
  only the event name as body.
- **Rule 4, images**: the collector, rum-api and grafana use `:latest`. Above each `image:` line is
  the tested version and digest (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0). Before, the
  branch pinned 0.4.0 for all three. "Image versions" paragraph in guide step 4f, and a
  troubleshooting row (guide table, README "Things that bite") for a newer `latest` that rejects a
  config.
- **rum-api 0.5.0** gets `OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS` / `_PROTOCOL` /
  `OTEL_SERVICE_NAME` pointed at the collector. rum-api now depends on the collector, not the other
  way round (as in tiny-shop-otel).
- **Rule 2, paths**: no `~/Desktop`. `mkdir -p tiny-shop-replay/...` from wherever the reader keeps
  projects. Each tab then runs `cd backend`, `cd frontend` or `cd stack`, and the intro says paths
  are relative to `tiny-shop-replay/`.
- **Rule 1, shape**: a folder tree at the top of the guide. README and guide both say 30 minutes
  (they said 25 and 30).
- **Rule 3, ports**: a "Check the ports" paragraph in step 4f (`lsof`, `stack/.env`, never stop
  what holds a port). Steps 5 and 6 say where moved collector ports go (`OUO_OTLP_ENDPOINT`,
  `frontend/.env.local`). The README links to a `## Ports` section that did not exist, and its
  `rum.js` `<details>` was never closed; both are fixed. Every file block's summary now says
  "(click to open)".
- **Rule 5, packages**: a "Package | What it does here" table at each install (steps 2, 3, 5, 6),
  plus two collapsibles. "Which OpenTelemetry Node package is which" covers `sdk-trace` vs the
  deprecated `sdk-trace-base` / `sdk-trace-node`, and `sdk-node` vs `auto-instrumentations-node`.
  "What `@ouo11y/browser` brings with it" says openly that the SDK pulls deprecated 2.x packages
  (N56) and links to tiny-shop-otel for the 3.0 packages. None of the packages the reader installs
  directly is deprecated (checked with `npm view <pkg> deprecated` and each package's README).
- **`@ouo11y/browser` 0.2.1 -> 0.3.0** (pinned). Reason: it is the current release. It adds gzip
  delivery and retry, and makes masking by selector possible, so the README now mentions
  `replay.blockSelector` / `maskTextSelector` instead of "classes only".
- **Rule 6, readable telemetry**: the example emits no log records of its own. The backend sends
  only traces, and `captureError` goes through the SDK. The SDK's event lines in Loki have the
  event name as body, which is N57 and not a fix in this quickstart.
- **Rule 8, trade-offs**: not applicable; this quickstart uses every ouo component.
- README replay byte figures updated to today's measurement. kb `quickstart-replay.md` updated
  (versions, selector masking, sizes, IDs).

## Dependencies

- frontend: `@ouo11y/browser` 0.2.1 -> 0.3.0, the current release of the SDK this quickstart is
  about. No other dependency changed; `package-lock.json` regenerated (0.3.0 has fewer deps).

## How it was verified

- `docker compose -p tiny-shop-replay-verify` from `result/stack/` with shifted ports (Grafana
  23000, OTLP 24318, replay 24319, Loki 23100, Tempo 23200, health 23133), after
  `docker compose pull` on 2026-10-27. The `latest` digests equal the comments: collector 0.4.0
  `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`, rum-api 0.5.0
  `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`, grafana 0.5.0
  `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f`. All five services
  were up and rum-api was healthy.
- `result/backend` and `result/frontend` were copied out of the repo (`npm ci`), with the API on
  25001 and Vite on 25173 (`frontend/.env.local` with the moved ports). The frontend
  `vite build` passed.
- Headless Chromium (playwright-core 1.64.1, chrome-headless-shell) clicked Add, Apply coupon,
  Track my order x4, then checkout with `...0002` and with `4242...`. Results: OTLP `/v1/logs` and
  `/v1/traces` answered 200 and `/v1/replay/chunks` answered 202 (3 chunks).
- **Loki**: `session.start`, `navigation`, `web_vital` x3, `ouo.dead_click` (Apply coupon),
  `ouo.rage_click` (Track my order, `ouo_click_count=4`), `http.request.failed`, and `exception`
  ("checkout failed: card declined"). The exception has no `trace_id` (N55).
- **Tempo**: the guide's TraceQL `{ name = "charge card" && status = error }` finds the trace.
  It holds browser `click` + `POST`, then backend `POST /api/checkout`, `checkout`, and
  `charge card` (error, `exception` event), with `session.id` on every span.
- **ouo11y RUM**, through `/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions` and
  `/sessions/<id>`: the session is `errored`, with 1 error, 1 failed request, 9 traces,
  `has_replay` and `replay_kind rrweb`. The plugin's session page loaded in headless Chromium
  (screenshot). The replay renders with the banner blocked and the shipping line masked, and the
  timeline and logs show the dead and rage clicks and the error.
- **Masking on disk**: in the zcat of the stored chunks, `4000000000000002`, `4242424242424242`,
  `PARTNER20`, `48213`, the password, the email, the name and "Baker Street" each count 0, while
  "Tiny Shop" counts 2. The README's one-liner prints 0. The session stored 3 chunks, 2635 bytes
  gzipped, about 15 KB raw.
- **Intermediate files**: step 2's `package.json` + `server.js` and step 3's `package.json`,
  `main.jsx` and `App.jsx` were extracted from the guide. The API served products and declined
  `0002`, and `vite build` passed.
- `node examples/quickstarts/check-embeds.mjs`: in sync. `lychee --offline` (the CI command):
  0 errors. `lychee --offline --include-fragments` on the quickstart: 0 errors (`#ports` resolves).
- Torn down: `docker compose -p tiny-shop-replay-verify down -v`, and the app processes started
  for the check were stopped by PID.

## What is left

- N55, N56 and N57 are `@ouo11y/browser` work, not quickstart work.
- The guide's stack step groups Tempo and Loki under one heading (4c), where tiny-shop-otel gives
  each service its own bold sentence. The content is the same; left as is.

## For the next agent

- npm inside the worktree fails ("Exit prior to config file resolving"). Copy the folder to the
  scratchpad, run `npm install --package-lock-only` there, and copy the lockfile back.
- The rum-api session list (via plugin-proxy) showed the session within seconds. Tempo search
  took about a minute.
