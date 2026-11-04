# Web Vitals and INP attribution

Status: normative for `@ouo11y/browser` 0.4 and rum-api. Scope: the browser `web_vital` event,
the attribution of INP (Interaction to Next Paint), and the rum-api read that groups INP by
element. LCP and CLS attribution, `browser.web_vital` names (checklist N26) and per-soft-navigation
vitals are later parts of roadmap package WB3. Mobile vitals are
[mobile-vitals.md](mobile-vitals.md).

## 1. The `web_vital` event

One OTel log record per report, `event.name = web_vital`, with the session identifiers of
[session-lifecycle.md](session-lifecycle.md) and:

| Attribute | Type | Meaning |
|---|---|---|
| `ouo.web_vital.name` | string | `TTFB`, `FCP`, `LCP`, `CLS`, `INP` |
| `ouo.web_vital.value` | double | ms (CLS: unitless score) |
| `ouo.web_vital.rating` | string | `good`, `needs-improvement`, `poor` (web-vitals thresholds) |
| `ouo.web_vital.id` | string | one value per metric and page load; a later report with the same id replaces the earlier one |
| `ouo.web_vital.delta` | double | change since the previous report with this id |
| `ouo.web_vital.navigation_type` | string | web-vitals `navigationType` |
| `url.path` | string | the path when the metric was measured |

The SDK reports CLS, FCP, LCP and TTFB as web-vitals reports them, and INP when the page is hidden
or left (`visibilitychange` to hidden, and `pagehide` for Safari), once per value.

## 2. INP attribution

Added to the INP `web_vital` event when the browser provides it (Event Timing for the phases,
Long Animation Frames, Chromium 123+, for the script):

| Attribute | Type | Meaning |
|---|---|---|
| `ouo.web_vital.inp.target` | string | the interaction's element, as `app.widget.id` of the click events: tag, `#id`, the first two classes, `[data-testid=…]` of the closest actionable ancestor (a button, a link, a form control, `[role=button]`, `[data-testid]`, …). Never text or other attribute values |
| `ouo.web_vital.inp.interaction_type` | string | `pointer` or `keyboard` |
| `ouo.web_vital.inp.input_delay_ms` | double | from the input to the first event handler |
| `ouo.web_vital.inp.processing_duration_ms` | double | the event handlers |
| `ouo.web_vital.inp.presentation_delay_ms` | double | from the last handler to the next paint |
| `ouo.web_vital.inp.load_state` | string | `loading`, `dom-interactive`, `dom-content-loaded`, `complete` |
| `ouo.web_vital.inp.script.invoker` | string | the longest Long Animation Frame script that overlapped the interaction: its invoker (`BUTTON#save.onclick`, `Window.setTimeout`, a script URL) |
| `ouo.web_vital.inp.script.invoker_type` | string | `event-listener`, `user-callback`, `classic-script`, `module-script`, `resolve-promise`, `reject-promise` |
| `ouo.web_vital.inp.script.subpart` | string | the phase it ran in: `input-delay`, `processing-duration`, `presentation-delay` |
| `ouo.web_vital.inp.script.duration_ms` | double | how long it overlapped the interaction |
| `code.file.path`, `code.function.name` | string | the script's source URL and function (semconv, as on `ouo.long_animation_frame`) |
| `ouo.web_vital.inp.script.char_position` | int | character position in the source, when known |
| `app.screen.name` | string | the route template (`rum.setRoute`) when the interaction happened, not when the event was sent |

Rules:

- **No text.** The target is built by the SDK. When the element left the DOM before web-vitals
  saw it, web-vitals falls back to the browser's own `targetSelector`; the SDK leaves the target
  out then rather than send a string it did not build. Attribute values other than `id`, classes
  and `data-testid` are never read, so the replay's text masking (ADR-0003 revision 2026-11-03)
  needs no extra rule here.
- The script is carried on the INP event itself, so no join with `ouo.long_animation_frame` is
  needed (that event has a 100 ms threshold and a per-page budget; INP's script has neither).
- web-vitals' attribution build and the mapping live in the lazily loaded chunk
  `dist/attribution-*.js` (5.8 KB gzip), imported when `initRUM` runs. Its observers read buffered
  entries, so the page load's metrics are complete; an interaction under 104 ms before the chunk
  arrived is not buffered by the browser and is not seen (it could not be the page's INP unless
  every later one is faster still).

## 3. rum-api: slowest interactions

`GET /v1/vitals/inp/targets?from=&to=&service=&environment=&release=&platform=&project=&page=&limit=`

Reads the range's INP events from Loki (`{event_name="web_vital"} | ouo_web_vital_name="INP"`),
keeps one value per page view (per `session.id` and `ouo.web_vital.id`, the largest), and groups
them by target and page. The page is `app.screen.name` when the app names its routes, else
`url.path`; `page` filters on either. Groups are sorted by p75, slowest first; `limit` defaults to
50, at most 500. The range defaults to the last 24 hours, at most 31 days (as funnels).

```json
{"groups":[
  {"target":"button.btn.chaos-btn","page":"/chaos","interaction_type":"pointer",
   "count":12,"sessions":9,"p75_ms":336,"max_ms":352,"rating":"needs-improvement",
   "input_delay_p75_ms":1.2,"processing_duration_p75_ms":301,"presentation_delay_p75_ms":24,
   "script":{"invoker":"BUTTON.onclick","invoker_type":"event-listener","file":"https://…/index.js","function":"onClick","count":12}}],
 "total":4,"page_views":31,"from":"…","to":"…"}
```

- `p75_ms` and the phase p75s are nearest-rank (the value at rank ⌈0.75 n⌉), the rule of the
  funnel times; a phase is `null` when no page view in the group sent it.
- `rating` rates `p75_ms` with the INP thresholds: good up to 200 ms, poor above 500 ms.
- `script` is the script seen most often in the group (`count` of the group's page views),
  `null` without Long Animation Frames.
- A group with `target: ""` holds the page views whose INP had no target.
- Bounded by the Loki read of the range (20 pages of 5,000 records), like the funnel reads.

## 4. Plugin

The **Performance** page (`/a/ouo11y-rum-app/performance?from&to&service&environment&release&project&page`)
shows "Slowest interactions by element": one row per group with the element, page, type, p75 INP
coloured by rating, the three phase p75s, the script and the counts.
