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

`build-it-yourself-guide.md` added at the founder's request. It starts from quickstart 4's result (#68) and covers only the changes: rename, the two stack files built from a clone (`OUO11Y_REPO`, now a compose variable), `App.jsx`, `rum.js`, `server.js`, the generator, building the funnel in Grafana, and drop-off to replay. It ends with a troubleshooting table; every changed file is embedded and checked by `check-embeds.mjs`.

Followed once from scratch in a scratch folder:
- fresh copy of #68's `result/`, files pasted from the guide's own blocks, a clean worktree as the clone;
- the step 2 check printed the documented 400;
- a manual purchase in the browser;
- the generator gave 45 / 37 / 28 / 20 / 10;
- the funnel built through the UI exactly as written read 46 / 38 / 29 / 21 / 11 (the generator plus the one manual session, as the guide says);
- drop-off to replay worked.

Two fixes came out of that run: the rename now also covers the `<title>Tiny Shop Replay</title>` (fixed in `result/` too), and step 1 is described as already filled in.
