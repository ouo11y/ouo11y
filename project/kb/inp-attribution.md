# INP attribution: web-vitals attribution build in a lazy chunk, linked LoAF, grouping by element

Answers: how `@ouo11y/browser` attributes INP (target, phases, Long Animation Frame script) without
growing the core bundle, what web-vitals 6.2.3 does with the target, and how rum-api groups INP by
element (F3, roadmap WB3 part 1, 2026-11-04). Spec: [docs/specs/web-vitals.md](../../docs/specs/web-vitals.md).

## Bundle decision

- `web-vitals` and `web-vitals/attribution` are two separate bundled files in the package
  (`exports` "." is `dist/web-vitals.js`, "./attribution" is `dist/web-vitals.attribution.js`),
  each with its own copy of the lib modules (visibility watcher, bfcache, `initUnique`). Importing
  INP from one and the other metrics from the other duplicates them. The lazy chunk
  (`src/vitals/attribution.ts`) imports all five metrics from `web-vitals/attribution`.
- Moving web-vitals out of the core entirely shrank `index.js` from 45,218 to 42,410 B gzip
  (-2.8 KB); the chunk `attribution-*.js` is 5,924 B gzip (budget 6.0 KB). The `index.js` budget
  stays 44.2 KB (no change on that line, so the consent PR #159 raising it does not conflict);
  the freed headroom is the roadmap §8 "core held at its budget" rule in practice.
- As for the rrweb chunk (`replay-privacy.md`), the lazy module must not import a core module or
  esbuild emits a shared `chunk-*.js` without a budget. The core passes the target generator
  (`clickTarget` + `describeElement`) into the chunk as a function instead.
- `scripts/compat.mjs` needs a source-map probe per built file: a string literal of the chunk
  (`"ouo.web_vital.inp.target"`) that must map back to `src/vitals/attribution.ts`.

## Loading late is fine for vitals

web-vitals' `observe()` uses `buffered: true` for every entry type, so FCP, LCP, CLS, TTFB and
Long Animation Frames from before the chunk arrived are read. Event Timing only buffers entries of
104 ms or more, so a faster interaction before the chunk loads is missed; it cannot be the page's
INP unless every later interaction is faster. The INP page-hide listeners stay in the core,
registered synchronously at `initRUM`, so they still run before the SDK's flush-on-hide listener;
web-vitals' own `visibilitychange` capture listener is on `window`, which runs before any `document`
listener whatever the registration order.

## web-vitals 6.2.3 target rules

- `generateTarget(node)` is called once per interaction while the node is still attached
  (`saveInteractionTarget`); its result is used as given, `undefined` or `null` falls back to
  web-vitals' `getSelector` (tag, id, all classes, up to 100 chars). Return `""` to send nothing.
- When the event's `target` is already null (the element was removed), web-vitals uses the
  browser's `PerformanceEventTiming.targetSelector` without calling `generateTarget`. The SDK keeps
  a set of the targets it generated and drops any other string (fail closed: it did not build it).
- The SDK target is the click events' `app.widget.id` (`button#save.btn.primary[data-testid=x]`,
  closest actionable ancestor), so INP rows join clicks, rage and dead clicks by the same string.
  Chaos buttons in `examples/ouo-web` have no id or test id, so all of them share
  `button.btn.chaos-btn`; adding `data-testid` would also change their `app.widget.name` (a test id
  wins over the text), which the demo's dead-click check reads.
- `attribution.longestScript` (`entry`, `subpart`, `intersectingDuration`) is the LoAF link: the
  script is on the INP event, no join with `ouo.long_animation_frame` (100 ms threshold, budget).

## Route of a deferred report

The SDK emits INP at page hide, and the log processor stamps `app.screen.name` at emit time (only
when the record has none). In a SPA that left the page of the slow interaction, that is the wrong
route. The core now stamps the route when INP changes; `url.path` was already the interaction's.

## rum-api grouping

One value per page view (`session_id` + `ouo_web_vital_id`, the largest: the SDK may report the
same id twice at hide, Chromium's `pagehide` then `visibilitychange`), grouped by target and page
(`app_screen_name`, else `url_path`), nearest-rank p75 like the funnel times, INP thresholds
200 / 500 ms. A LogQL `| (app_screen_name="x" or url_path="x")` filters on either page form.

## Verified

- Vitest (`test/vitals.test.ts`): mapping, own-target rule, route stamp, hide-time emission.
- Playwright, three engines (`e2e/sdk.spec.ts` "INP of a slow click"): `button#block`, phases;
  Chromium also the LoAF script (`BUTTON#block.onclick`, `processing-duration`).
- Demo app journey + verify against an ouo-env (see the agent summary of 2026-11-04).
