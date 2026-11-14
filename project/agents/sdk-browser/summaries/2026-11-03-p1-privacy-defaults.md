# 2026-11-03 P1 privacy defaults: mask all text, ouo-unmask, never-record routes and screens

Work item P1 for a pilot client (care company, GDPR Art. 9 data), directed by the founder on
2026-11-03. Branch `claude/p1-mask-all-text`, one PR. ADR-0003 revision 2026-11-03 and ADR-0006
revision 3 record the decisions.

## Done

Web (`@ouo11y/browser`, breaking, ships as 0.4.0):

- `replay.maskAllText` (default **true**) and `replay.unmaskTextSelector`; class `ouo-unmask`.
  Every text node and the text attributes (`title`, `alt`, `placeholder`, `aria-label`,
  `aria-description`, `aria-valuetext`, `label`, a button input's `value`) are masked outside the
  allow-list. Precedence: `ouo-block` > `ouo-mask` / `maskTextSelector` (also inside an unmasked
  area, and an `ouo-unmask` inside a mask stays masked) > `ouo-unmask` > default. rrweb hooks
  only (`maskTextSelector: "*"` + `maskTextFn`), attributes in the emit callback through
  `record.mirror`. Code in the lazy chunk: new `src/replay/rrweb.ts` (also takes rrweb's static
  record options out of the core).
- Click names: `describeElement(el, unmask, mask)`. With `maskAllText` on, outside the allow-list
  (or inside a mask / block) `app.widget.name` is the `data-testid` alone; this applies to
  `click` spans, `ouo.rage_click` and `ouo.dead_click`, with or without replay. Fixed on the way:
  inside `ouo-mask` an `aria-label` used to win over the masking when a `data-testid` was set.
- `replay.excludeRoutes` (exact, `*` prefix, RegExp; `location.pathname` only): recorder
  `onRoute()` from the `navigation` event (synchronous in the history patch and `popstate`), and
  a route check in rrweb's emit callback.
  Entering: rrweb custom event `ouo.replay.hidden` `{reason: "route"}` pushed into the stream,
  OTel event `ouo.replay.hidden` (`ouo.replay.hidden_reason: route`), stop + flush. Leaving: new
  recording with a full snapshot `SHOW_DELAY_MS` (500 ms) later, because React Router changes the
  URL before rendering the next page (found in self-review: an immediate snapshot held the
  never-record page); tab claims cannot restart it earlier. Page loaded on an excluded route: nothing recorded. Markers once
  per session and hidden stretch.
- Bundle: core 45,223 B gzip (+185 B; budget 44.0 to 44.2 KB); rrweb chunk 77.2 to 55.3 KB gzip
  because the chunk now imports `{ record }` only (budget 82 to 60 KB).

React Native (`@ouo11y/react-native`, additive):

- `replay.excludeScreens` (screen name or path, `*` prefix, RegExp) and
  `rum.replay.hideScreen()` / `showScreen()`, a third pause source in the JS controller next to
  the host's pause and the sampling pause; `ouo.replay.hidden` OTel event (`screen` / `manual`).
  The navigation callback calls `replay.setScreen(path)` first; no `screenDidChange` while hidden.
- iOS and Android go through the existing native `pause()` / `resume()` (both keep
  `pausedByHost` across foreground and new activities / view controllers), so `sdk/ios` and
  `sdk/android` are unchanged.

Plugin: `ouo.replay.hidden` timeline events become a `hidden` replay marker (grey, legend entry).

Docs: ADR-0003 revision, ADR-0006 revision 3, `docs/specs/mobile-replay.md` (never-record
screens), `docs/operations/masking-proof.md` (web section rewritten for 0.4, proof by stored
events), `sdk/browser/README.md` ("Replay privacy"), `sdk/react-native/README.md` ("Never-record
screens", Stripe Identity guidance), `examples/fast-tracked/20-frontend.md` option table.
Demo `examples/ouo-web`: header, nav, catalogue, product page, chaos page and chaos buttons are
`ouo-unmask` (verify.py needs the "Dead button" click name); cart, checkout, order and the
session footer stay masked.

## Verified, and how

- `sdk/browser`: `npx vitest run` 27 files, 199 tests (new `test/privacy.test.ts` with the real
  rrweb recorder in jsdom, `test/privacy.integration.test.ts` through `initRUM` with
  `history.pushState`, route tests in `test/recorder.test.ts`); `tsc --noEmit`; `size:check`;
  `compat:check`; Playwright `e2e/playwright.config.ts` 70 tests in Chromium, Firefox, WebKit
  (new "replay masks all text outside ouo-unmask and records nothing on a never-record route",
  rage click name now absent).
- `sdk/react-native`: 22 files, 202 tests (controller and `initRUM` tests for excludeScreens /
  hideScreen and the emitted event); `tsc --noEmit`.
- Plugin: jest 28 suites / 202 tests, `tsc --noEmit`, eslint 0 errors (7 old warnings).
- `examples/ouo-web`: `npm run typecheck`.

## Not verified

- No iOS Simulator or Android emulator run of `excludeScreens` / `hideScreen()`: the JS path is
  unit-tested and the native `pause()` / `resume()` are unchanged. Stripe Identity is not in any
  example app; the README describes what our capture does with its windows from the capture code
  (key window on iOS, topmost root view on Android), not from a run.
- The ouo-web journey + verify against a stack runs in CI (examples job), not locally.
- `rrweb-cost.spec.ts` and the soak (nightly) were not run.
- No Grafana re-capture for the masking proof (follow-up).

## Next agent must know

- npm fails with "Exit prior to config file resolving" when run from the worktree root: npm
  walks up to the shared checkout `/Users/ziadhassanin/Desktop/personal/ouo`, whose
  `package.json` workspaces include a conflicted `package.json`. Use `npm --prefix <worktree>`
  from outside, or run inside a workspace folder (kb `diy-browser-rum.md` had seen it).
- release-please: the `!` title bumps `@ouo11y/browser` 0.3.1 to 0.4.0; it lists the change under
  "⚠ BREAKING CHANGES". Rename the section to "Changed (breaking)" in the release PR, and drop
  the breaking marker from the React Native entry (its change is additive).
- Follow-ups: `examples/ouo-web` stub build (`tsconfig.stub.json`) already fails on origin/main
  (`sampleRate` missing in `rum-stub.ts` types); quickstarts pin 0.3.0 / ^0.2.1 and need
  `ouo-unmask` (or `maskAllText: false`) when bumped to 0.4; a native `OuoReplay.hideScreen()`
  with a marker for apps without React Native; hash-route matching for `excludeRoutes`.
- Dependencies: none added.

## Review round 1 (2026-11-04, reviewer session review-pr154)

Findings and what changed:

- A (popstate ordering leak): fixed. Every event rrweb hands over is checked against the route in
  the emit callback (`hide()`: marker, stop, drop). New e2e test with a router `popstate`
  listener registered before `initRUM` (the reviewer's probe A), three engines; unit test in
  `recorder.test.ts`.
- B (template matching after render, stale `route.name`): template matching removed; pathname
  only. `routeName` option and the `setRoute` hook are gone.
- C (form `value` / state leaks): with `maskAllInputs` every form control's `value` is masked,
  `checked` / `selected` dropped, Input events masked (`text`, `isChecked: false`); with
  `maskAllText`, `value` on other elements is masked outside the allow-list. Test with the
  reviewer's probe D markup plus a radio click and a value mutation; a `maskAllInputs: false`
  test keeps rrweb's behaviour for controls.
- D: README and ADR now ask for `ouo-block` on a never-record page's root as the hard guarantee,
  and list what stays unmasked (`class`, `id`, `href`, `src`, `style`, `data-*`).
- E, F (RN): leaving a hidden screen resumes `SHOW_DELAY_MS` (500 ms) later; the native recorder is
  never started while hidden (started once shown, for the current session). Fake-timer tests.
- G/H: noted; PR #152 must move its import change into `src/replay/rrweb.ts`.

Sizes after the round: core 45,218 B gzip (budget 45,261), rrweb chunk 55.3 KB.
