# 2026-11-15: from-scratch series (00 stack, 01 web, 02 React Native, 03 plugin)

Session `quickstart-guides-series`, branch `claude/quickstart-guides-series-f935f3`, asked by the founder: one build-it-yourself series on the stack as it stands after ADR-0025 (generic libraries, clients own the plugin), with a guide for building a plugin.

## What was done

- `examples/quickstarts/from-scratch/`: `README.md` (series index, how to run `result/`, ports, versions, what is missing), `00-stack.md`, `01-web.md`, `02-react-native.md`, `03-plugin.md`, and one `result/` for the series (`stack/`, `web/`, `mobile/`, `plugin/`). Every final file is embedded with `<!-- embed: -->` markers; intermediate files (plain `App.jsx`, plain `App.tsx`, the 00 Grafana compose) are written in the guides without a marker.
- Stack: stock `otel/opentelemetry-collector-contrib:0.160.0` (basicauth, routing to Muninn, file_storage queue), Tempo 3.0.3, Loki 3.7.7 (labels include `ouo.project.id`, which `ouo-go` selects on), `ghcr.io/ouo11y/muninn:0.1.0` on a directory, Grafana 13.2.5. No rum-api, no Mimir, no MVP plugin.
- Plugin: `@grafana/create-plugin@9.0.3` app with backend, `ouo-go` v0.1.0 (ListSessions, SessionEvents, ListReplays, Manifest, Chunk, `redact`), `@ouo11y/kit` 0.1.0 `ReplayPlayer`; access rule: Grafana Viewers never see identity. Backend test with a fake Loki.
- `examples/quickstarts/check-embeds.mjs`: an empty embed block (a placeholder) made the pattern run on to the next block and `--write` deleted the text between them. The body is now matched as whole lines; existing guides unchanged.
- Index rows: `examples/quickstarts/index.md` (list and rules status), `examples/quickstarts/README.md`, `docs/index.md`.
- kb: `project/kb/plugin/scaffolding/create-plugin-app-with-backend.md`, `project/kb/muninn/collector-path/contrib-collector-for-muninn.md`.

## Verified, and how

- Stack from `result/stack` as compose project `fs-verify` on shifted ports (Grafana 23000, OTLP 24318, Loki 23100, Tempo 23200, Muninn 23400, health 23133): all services up; OTLP 401 without credential, 200 with `demo`, CORS preflight 204; the guide's curl `hello` record in Loki with `ouo_project_id=demo`.
- Web (built in the scratchpad exactly as the guide says, `create-vite` 9.3.4, `@ouo11y/browser` 0.4.1): headless Chromium (Playwright 1.60) clicked sign-in, add to cart twice, cart, checkout. Loki: `session.start`, `browser.navigation` x2, clicks, web vitals, `add_to_cart` x2, frustration, `exception` (message and `enduser_id=alice`), `ouo.replay.chunk`; Tempo: `documentLoad` and two `GET` spans found by `span.session.id`; Muninn: one `rrweb/2` replay. The plain step-2 `App.jsx` was extracted from the guide and built with `vite build`.
- React Native (`create-expo-app` blank-typescript, Expo 58, RN 0.88.1, `@ouo11y/react-native` 0.4.0) on an iOS 27 Simulator I created and deleted afterwards: tapped through the shop; Loki: `session.start`, `navigation` x2, `ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`, `http.request`, `add_to_cart` x2, `exception` with `user_id=alice`, 6 replay references; Muninn: one `ouo-frames/3` replay of 6 chunks. A second run from an empty folder followed the guide's order (plain app, `npx expo run:ios --no-bundler`, then SDK install and a second build): both builds succeeded and the second ran `pod install` by itself.
- Plugin (scaffolded, built as in the guide): `go vet ./pkg/...` and `go test ./pkg/...` pass, `npm run typecheck`, `npm run lint`, `npm run build` clean; loaded by the stack's Grafana (`Plugin registered`). Headless Chromium: the list showed web and mobile sessions; a web session played its rrweb replay (product list unmasked by `data-ouo-unmask`, the rest `***`) above its events; a mobile session showed kit's "Stored, not playable here" and its events. As a Viewer the sessions and a session's events had no identity (0 occurrences of `alice`, 11 as Admin); a bad session id answered 400, an unknown one 404.
- `node examples/quickstarts/check-embeds.mjs` in sync; `lychee --offline` 0 errors.

## Not verified

- Android, a physical phone, and Intel Macs (the amd64 plugin binary was built, not run).
- The final `mobile/App.tsx` cart padding change was typechecked and built in the second run, not looked at on a screen.

## What the next agent must know

- `ouo-go` v0.1.0 has no funnel, health, vitals or trace readers (they landed in #196 after the tag); the plugin guide says so. When `ouo-go` is tagged again, a guide 04 (funnels page) is the natural next one.
- When a collector release includes `file_storage`, 00 can switch to `ghcr.io/ouo11y/collector` with `ouoratelimit`; the `replay-queue-init` service then goes (the ouo image ships the directory owned by `nonroot`).
- When `@ouo11y/kit` plays `ouo-frames/3`, 03 step 6 and the README's "what is not there yet" change.
- Dependencies added (all in the example apps only): `@ouo11y/browser` (the web SDK), `@ouo11y/react-native` and `@react-native-async-storage/async-storage` (the mobile SDK and its storage), `@ouo11y/kit` (replay player), `github.com/ouo11y/ouo11y/libs/ouo-go` (readers), plus what `create-vite`, `create-expo-app` and `@grafana/create-plugin` scaffold.

## Envs

No `ouo-env` env was used. Compose project `fs-verify` was torn down with `docker compose -p fs-verify down -v`; both simulators deleted; Vite and Metro stopped.
