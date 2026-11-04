# ADR-0003 One session, one replay, many chunks

Status: accepted (2026-10-06); revision 2026-11-03 (mask all text by default, `ouo-unmask`, never-record routes; directed by the founder on 2026-11-03 at the request of the client JUHI, whose screens show health-related personal data, GDPR Art. 9) at the end

## Context

The MVP asks whether one session equals one replay or whether a session can contain several replays.

## Decision

**One session has exactly one replay.** The replay is an ordered sequence of chunks:

- The web SDK runs `rrweb.record` for the life of the page and flushes buffered rrweb events as a chunk every 5 seconds or when the buffer exceeds 256 KB, whichever comes first, and on `pagehide` via `fetch(..., { keepalive: true })`.
- A chunk is `{ session_id, seq, started_at, ended_at, events: [...] }`, gzip-compressed, posted to `rum-api` `POST /v1/replay/chunks`. `seq` is monotonic per session and persisted with the session so a reload continues the sequence.
- Every full page load starts a new rrweb recording, which begins with a full snapshot. A replay therefore contains one or more full snapshots; the rrweb replayer handles that natively, so the player simply concatenates all chunks of the session in `seq` order.
- rrweb's `checkoutEveryNms` is set to 5 minutes so long single-page sessions also get periodic full snapshots, which keeps seeking cheap.
- Storage layout: `replays/<session_id>/<seq padded to 6>.json.gz` plus `replays/<session_id>/meta.json` (chunk count, time range, bytes). Filesystem in the MVP, behind a `ReplayStore` interface.
- Privacy: `maskAllInputs: true` by default, `blockClass: "ouo-block"`, `maskTextClass: "ouo-mask"`. Replay can be turned off independently of telemetry (`replay.enabled: false`) and paused at runtime.
- Mobile has no replay in the MVP.

## Consequences

- No separate "replay id". `session.id` is the key everywhere, which keeps the timeline, traces and replay trivially joinable.
- Missing chunks degrade gracefully: the player plays from the next full snapshot.
- Replay bytes never pass through the OTel Collector or Loki.

## Revision 2026-11-03: masked by default, never-record routes

Status: accepted (2026-11-03). Directed by the founder on 2026-11-03 at the request of the client JUHI, a care company replacing Sentry with ouo11y: its admin portal and PWA show personal data on every page, including data concerning health (GDPR Art. 9), so "masked by default" and "never record this screen" are hard requirements. The roadmap had planned the option as WB5 with "a default decided in an ADR-0003 revision" (`project/kb/web-sdk-research/roadmap.md`); this is that decision, taken ahead of the rest of WB5.

Context: until 0.3 the web SDK masked input values only. Text was recorded unless the page marked it `ouo-mask` or matched `maskTextSelector`, so a page that forgot a class leaked whatever it displayed, and click names (`app.widget.name`) carried button and link text into telemetry. The mobile SDKs already redact all text, images and web views by default (ADR-0006).

Decision:

- **`replay.maskAllText`, default `true`.** Every text node is recorded with each non-space character replaced by `*`, and so are the attributes that carry text a person reads (`title`, `alt`, `placeholder`, `aria-label`, `aria-description`, `aria-valuetext`, `label`, and `value` on elements that are not form controls). Implemented with rrweb's own hooks, not a fork: `maskTextSelector: "*"` hands every text node to `maskTextFn`, which applies the allow-list with `closest()`; attributes are masked in the SDK's emit callback, looking the element up in rrweb's mirror. The code lives in the lazily loaded replay chunk (`sdk/browser/src/replay/rrweb.ts`).
- **Allow-list: the class `ouo-unmask`** (and `replay.unmaskTextSelector`): text inside it is recorded as written.
- **Precedence**: `ouo-block` / `blockSelector` (not recorded at all) wins over everything; `ouo-mask` / `maskTextSelector` masks inside an unmasked area, and an `ouo-unmask` inside a masked area stays masked; then `ouo-unmask`; then the default. Form controls stay governed by `maskAllInputs` (default `true`), which now covers what rrweb's own input masking leaves out: the `value` of radios, checkboxes, hidden inputs, `<option>` and `<button>`, the checked / selected state (left out, so a radio replays unchecked) and the value and state of rrweb Input events; everywhere, `ouo-unmask` included (review of PR #154: a checked `value="depression"` radio reached the replay). An element rrweb cannot resolve, a shadow root under an unmasked host, or an invalid host selector, is masked (fail closed).
- **Click names follow the same rule**, with or without replay: outside the allow-list, `app.widget.name` on `click` spans, `ouo.rage_click` and `ouo.dead_click` is the element's `data-testid` alone, never its text, `aria-label`, `title` or `name`. `app.widget.id` (tag, id, two classes, `data-testid`) stays: it is the developer's structure, not the user's data.
- **Never-record routes: `replay.excludeRoutes`**, an array of exact paths, prefixes ending in `*` (the funnel `page:` rule, ADR-0012) and RegExps, matched against `location.pathname` only (a `setRoute` template arrives in an effect after the page rendered: matching it could not keep the page out). While one matches, nothing is recorded. Entering one writes an rrweb custom event `ouo.replay.hidden` (`{ reason: "route" }`) into the replay and an `ouo.replay.hidden` OTel event (`ouo.replay.hidden_reason: route`) on the timeline, then stops rrweb and flushes; leaving it starts a fresh recording 500 ms later (`SHOW_DELAY_MS`: routers change the URL before they render the next page, so a snapshot at once would hold the never-record page's DOM; no tab claim restarts it earlier), which begins with a full snapshot (the player shows the last frame before the gap until then). The check runs synchronously in the SDK's history patch and `popstate` listener, so a router that renders the new page and updates the URL in one task has its mutations dropped by `stop()` before rrweb hands them over (they wait in a microtask); it runs again in the emit callback for every event rrweb hands over, which drops the event and stops when the URL is already on an excluded route (a router's `popstate` listener registered before the SDK's renders first, and the browser's microtask checkpoint between listeners lets rrweb emit it; a router that captured the unpatched `pushState`). A page loaded on an excluded route records nothing. The hard guarantee for the remaining gaps (a render in a later task than the URL change, a page kept on screen beyond the 500 ms when leaving) is `ouo-block` on the page's root, which the README asks for.
- `maskAllText: false` restores the 0.3 behaviour exactly.

Consequences:

- **Behaviour-breaking for 0.x users**: an app upgrading sees asterisks where it saw text, and click names disappear unless the element has a `data-testid` or sits in `ouo-unmask`. It ships in `@ouo11y/browser` 0.4.0 under "Changed (breaking)", with the opt-out in the README. The demo storefront (`examples/ouo-web`) marks its public catalogue, header and chaos panel `ouo-unmask` and keeps cart, checkout and account data masked.
- Replays of unannotated pages are layout, motion and clicks, not content; teams annotate what is safe to read. This is the default Sentry ships and what the mobile SDKs already do.
- Importing `record` alone instead of the rrweb namespace let the bundler drop rrweb's replayer from the lazy chunk (77.2 to 55.3 KB gzip). The core grows by 185 B gzip (budget 44.0 to 44.2 KB) for the route check, the hidden marker and the click-name rule.
- Not covered: URLs (`url.full`, the `ouo.tab` marker) and the attributes `class`, `id`, `href`, `src`, `style`, `data-*` are not masked (roadmap WB7 scrubs query strings); hash routes (`/#/patients`) are not matched; a router that renders a page in one task and updates the URL in a later one records that render (use `pause()`/`resume()` or `ouo-block`). Mobile never-record screens are ADR-0006 revision 3.
