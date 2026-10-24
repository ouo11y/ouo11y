# 2026-10-24 Quickstart 5: tiny-shop-funnels (N47)

Session: `funnels`. Branch `claude/funnels-quickstart`, stacked on `claude/funnels` (N46, the feature).

## Done

`examples/quickstarts/tiny-shop-funnels/`, same layout as quickstart 4 (PR #68): README with collapsible sections, `result/` with
- `frontend/`: React shop with five routes through `history.pushState` (`/`, `/products/<id>`, `/cart`, `/checkout`, `/orders/<id>`) and `rum.addEvent` for `add_to_cart`, `checkout_submitted`, `order_paid`; replay on, inputs masked; no sampling.
- `backend/`: products and a checkout that declines card `...0002` (500), returns the order total.
- `generate-sessions/`: Playwright (devDependency, `1.64.1` like `examples/ouo-web` and `tests/e2e`: drives real browsers so the real SDK sends real page views, events and replays) driving 50 sessions over 8 seeded personas, then printing the expected count per step.
- `stack/`: split compose via `include:`; `50-rum-api` builds `services/rum-api` and `60-grafana` builds the plugin (`Dockerfile` + `Dockerfile.dockerignore`, repo root as context) because the released `0.3.0` images have no funnels. Both files say to switch back to `image:` once a release is tagged.

## Verified

- Quickstart stack on shifted ports from this worktree, then **from a clean `git worktree` of the branch** with the images deleted first, following the README (including its "Ports taken?" path, since 4318 was the `main` env's): `docker compose up -d --build`, `npm install && npm start`, `npm run dev`, `npm run generate`.
- Generator hand count 45 / 37 / 28 / 20 / 10 (5 not entered); the README's `curl` against rum-api gave exactly that; the README's funnel link opened the page with the four drop-offs 8 / 9 / 8 / 10.
- Same numbers on ouo-env `funnels` and in the browser (see `project/agents/rum-api/summaries/2026-10-24-funnels.md`).
- `node examples/quickstarts/check-embeds.mjs`: in sync.

## Left / next

- After the founder tags rum-api and grafana releases with funnels: replace both `build:` blocks with the released `image:`, delete `60-grafana/Dockerfile*`, drop the "Released images" note in the README.
- PRs #67 / #68 also edit `examples/quickstarts/{README,index}.md` and the checklist: expect a trivial merge conflict on those rows.
- No build-it-yourself guide, like quickstart 4.

## Follow-up (same day): build-it-yourself guide

The founder asked for `build-it-yourself-guide.md`. The first version built on quickstart 4's result; the founder corrected that, since every quickstart is standalone. The guide now starts from an empty folder, like `tiny-shop`:
- step 0: tools and a clone (for rum-api / Grafana until a release);
- steps 1–3: a plain API and a plain five-page shop with no telemetry, shown inline;
- step 4: the stack, one service at a time, every file embedded;
- steps 5–6: the instrumented API, then the shop with `rum.js` and the three `rum.addEvent` calls;
- step 7: the generator;
- steps 8–9: building the funnel in Grafana and following a drop-off to its replay;
- step 10: clean-up, then a troubleshooting table.

There are 25 embeds, checked by `check-embeds.mjs`.

**Shape.** The `60-grafana` build now uses the reader's own `Dockerfile` (context `.`), with the clone passed as the named build context `ouo11y` (`OUO11Y_REPO`); BuildKit sends only the copied files. `Dockerfile.dockerignore` is gone. So `result/` is exactly what the guide ends with: README.md, build-it-yourself-guide.md and result/, no files/.

**Followed once from an empty folder.** Each file was written from the guide's own blocks in the guide's order. Phase A (the plain API with curl, the plain shop clicked through to "paid") ran before any later file existed. After step 7, `diff -r` against `result/` (excluding node_modules, lockfiles, logs and `.env.local`) was identical. Then, with the images deleted:
- the step 4 check returned the documented 400;
- step 5 printed the `[otel]` line;
- step 6's purchase showed every page and event in the session, with a replay;
- the generator gave 45 / 37 / 28 / 20 / 10;
- the Funnels page read 46 / 38 / 29 / 21 / 11 (plus the manual purchase, as the guide says), and the drop-off listed 10 sessions with Replay.

Other sessions held 5001, 5173, 3000, 3100, 3200, 4318 and 13133, so the run used the guide's "ports taken" overrides on a 37xxx block. `OUO_COLLECTOR_HEALTH_PORT` was added to that row. The plain step-3 app hard-codes the API on 5001, so for that check only the test copy pointed at 37001.
