# 2026-10-24: quickstart 4, tiny-shop-replay (N54; was N43 on its branch)

## Done

`examples/quickstarts/tiny-shop-replay/`, standalone (own frontend, backend, stack; no file of another example referenced), with the stack split like quickstart 2 (`stack/compose.yaml` has `name:` and `include:` only; `10-collector`, `20-tempo`, `30-loki`, `50-rum-api`, `60-grafana`, each file commented). Mimir, metrics and frontend logs were left out to keep the bite to replay. README: "What's new" first, collapsible sections, five-minute run, the masking table, rage/dead clicks, replay -> trace -> error, storage and cost, the whole `rum.js` embedded (`check-embeds.mjs`).

- `rum.js`: `session.sampleRate`, `replay.sampleRate` / `onErrorSampleRate` / `maskAllInputs`, `clicks` defaults spelled out.
- `App.jsx`: an `ouo-block` banner, an `ouo-mask` shipping line, name / email / password / card inputs, **Apply coupon** (empty handler: dead click), **Track my order** (3 s API: rage click), checkout with `rum.captureError` on failure.
- `server.js`: card ending `0002` answers 500 with an error `charge card` span; other cards succeed.
- `50-rum-api/config.yaml`: filesystem store explained, S3 / MinIO example commented.

Pinned: `@ouo11y/browser` `0.2.1` (exact), `ghcr.io/ouo11y/{collector,rum-api,grafana}:0.3.0`. No new dependency beyond quickstart 2's set (minus api-logs and the metrics packages).

## Verified, and how

Clean stack (`docker compose down -v` then `up`) on shifted ports (Grafana 13300, OTLP 14318, replay 14319; 4318 was taken by another env), API and Vite run with `node` directly, the shop driven in the desktop app's browser pane:

- Plugin session page: status `errored`, 1 failed request, timeline `ouo.dead_click` (Apply coupon), `ouo.rage_click` (Track my order, count 4), "Failed request 500", "Error: checkout failed: card declined"; the Replay panel plays (89 rrweb events) and clicking the Error item seeks the replay to the Checkout click.
- Masking: the replay frame shows asterisks in all four inputs, no banner, "Shipping to **** ***"; the stored chunks contain none of the password, card number, email, name or banner text (`zcat | grep -c` = 0).
- Replay -> trace -> error: the `click` trace at the error's second, status error, Open in Explore; Tempo shows browser `click` + `POST`, backend `POST /api/checkout`, `checkout`, `charge card` (error, `exception` event). TraceQL `{ name = "charge card" && status = error }` finds it.
- Cost: 27 s session = 5 chunks, 3.6 KB gzipped, 19 KB raw (first run); clean run 9 KB on disk for 6 files.
- `node examples/quickstarts/check-embeds.mjs` and lychee offline pass.

Stack torn down (`docker compose down -v`), API and Vite stopped. No env left running.

## Follow-up: build-it-yourself guide (same day, rewritten after the founder's correction)

`build-it-yourself-guide.md` follows `examples/quickstarts/README.md` ("How a quickstart is built"): an empty folder, then a plain Express API and a plain React shop with no telemetry (inline code: the slow route, the `0002` decline, the empty coupon handler, the form), then the split stack (embedded), then instrumenting the API (`package.json`, `instrumentation.js`, `server.js` replaced), then the shop (`@ouo11y/browser`, `rum.js` with replay sampling, `main.jsx`, `App.jsx` with `ouo-block` / `ouo-mask` and `captureError`). Each step ends with something visible, and the guide closes with clean-up and a "when something does not work" table. 22 embedded files, checked by `check-embeds.mjs`. Shape: `README.md`, `build-it-yourself-guide.md`, `result/` (no `files/` needed).

Followed from an empty folder outside the repo, applying the guide's file steps in order. After step 3 the plain shop worked: products listed, coupon did nothing, Track answered after 3 s, `...0002` gave "Payment failed", `...4242` placed an order. After step 6 `diff -r` against `result/` showed no differences. Checks run:

- step 4: five services up, rum-api healthy;
- step 5: curl decline, then TraceQL found the `charge card` error trace, but only after 1 to 2 minutes; the guide now says so;
- step 6: `POST :4319/v1/replay/chunks` answered 202;
- step 7: session `errored` with dead click, rage click, Failed request 500, the error, and 88 rrweb events;
- step 8: `grep -c` printed 0;
- step 9: the replay seeks to the error, and the error click trace holds `charge card` with its exception;
- step 10: `meta.json` showed 4 chunks, 3.5 KB.

Torn down with `docker compose down -v`, and both processes stopped.

Found on the way: sibling quickstart sessions (sessions, funnels) held port 5001 and stacks on 3200 / 13300 / 14318. The README's Ports section now also covers `OUO_TEMPO_PORT`, `OUO_LOKI_PORT`, `OUO_COLLECTOR_HEALTH_PORT`, `PORT` and `VITE_API_URL`, and the plain `server.js` reads `PORT`. On an earlier try, one test trace went to another session's collector on 14318.

## Gaps (in the checklist)

- (was N44) masking by CSS selector is not exposed (classes only). Fixed in `@ouo11y/browser` 0.3.0 (`replay.blockSelector`, `maskTextSelector`).
- N55 (was N45): `captureError` after `await fetch` has no trace id; error and trace are linked by time on the session page, not by id.
- The plugin's `Logs -> Same traces` is therefore empty for the error.
- `examples/quickstarts/README.md` intro still says quickstarts run on the one-file stack; PR #67 (quickstart 2) rewrites that line, so merge #67 first and keep its wording.

## Next agent

Quickstart 3 (sessions) waits on SDK session rotation; quickstart 5 is funnels. Reuse this stack folder as the base.
