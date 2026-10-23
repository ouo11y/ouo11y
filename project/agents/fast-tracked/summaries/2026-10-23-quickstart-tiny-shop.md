# 2026-10-23: quickstart `examples/quickstarts/tiny-shop`

## What was done

- New folder `examples/quickstarts/` (standalone apps against the one-file stack
  `deploy/compose/quickstart.yaml`, PR #52) with `index.md`, under `examples/` because a new top-level
  folder needs an ADR (ADR-0010).
- `tiny-shop/`: the app the founder built by hand in a walkthrough, cleaned up.
  - `backend/`: Express 5 API, `instrumentation.js` (OTel Node SDK 3.0, OTLP/HTTP exporter with
    the demo Basic credential, http + express instrumentation, `BaggageSpanProcessor`), `server.js`
    (manual spans `db.select products`, `checkout` > `validate cart` + `charge card`, error span on
    `/api/fail`). `OUO_OTLP_ENDPOINT` and `PORT` override the defaults.
  - `frontend/`: Vite + React 19; `src/rum.js` inits `@ouo11y/browser` (`VITE_OUO_ENDPOINT`,
    `VITE_OUO_REPLAY_ENDPOINT`, `VITE_API_URL`), `propagateTo` built from the API URL as a RegExp;
    `App.jsx` with Add (custom event), Checkout, broken API, crash. The SDK is the repo's
    `sdk/browser` via `file:`; the README says how to pack it for a copy outside the repo.
  - `README.md`: stack, SDK build, API, web app, what to look for in Tempo / Loki / the plugin,
    ports, copying it out, the four gotchas.
- `sdk/browser/README.md`: the `propagateTo` row said "exact string" origins; a string has to equal
  the whole request URL. Corrected.
- Index rows: `README.md`, `docs/index.md`, `project/agents/index.md` (fast-tracked now also owns
  `examples/quickstarts`), this agent's index and tracker, kb `otel-node-sdk-3.md`, checklist N31.

## Dependencies (new, example only)

- backend: `express`, `cors` (the API and its preflight), `@opentelemetry/{api, sdk-node, sdk-trace,
  resources, semantic-conventions, exporter-trace-otlp-http, instrumentation-http,
  instrumentation-express}` (SDK, export, auto-instrumentation), `@opentelemetry/baggage-span-processor`
  (RUM session on backend spans). frontend: `react`, `react-dom`, `vite`, `@vitejs/plugin-react` (the
  Vite React template). Lockfiles committed so the OTel 3.0 set stays reproducible.

## How it was verified

Against `quickstart.yaml` on shifted ports (the founder's own playground holds 5001 / 5173):
`PORT=5002 OUO_OTLP_ENDPOINT=http://localhost:24318 npm start`, Vite on 5174 with the three `VITE_*`
variables, clicks in the in-app browser.

- Collector: every `/v1/traces` and `/v1/logs` POST 200, replay chunks 202; an `OPTIONS` preflight
  before each API call (trace headers added).
- Tempo, trace `6c6c5da6...`: `tiny-shop-frontend POST` -> `tiny-shop-backend POST /api/checkout` ->
  middleware spans, `checkout`, `validate cart`, `charge card`; every span has the browser's
  `session.id`. `GET /api/fail` is an error trace.
- Loki for the session: `session.start`, `navigation`, `cart.added` x2, `http.request.failed`,
  `exception`, `web_vital`.
- rum-api: session `crashed`, `platform web`, `trace_count 3`, `has_replay true`.
- `vite build` of the frontend passes.

The first run used `propagateTo: [API]` (a string) and the backend trace was its own root: OTel
compares strings with `===` against the full URL (kb `otel-node-sdk-3.md`). Fixed to a RegExp and
re-run (the result above).

## Left / next agent must know

- Not in CI: no job installs and runs the quickstart apps. A cheap one: `npm ci` + `vite build` for
  the frontend, `node --check` for the backend.
- The `file:../../../../sdk/browser` dependency becomes `^0.2.0` once `@ouo11y/browser` is on npm;
  then step 2 of the README goes away.
- During cleanup a broad `pkill -f` pattern also stopped the founder's own playground backend
  (same command line); kill by PID.
