# RUM conventions: navigation and screens

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## Page load

**What OTel defines.**

| Name | Type | Status | Purpose |
|---|---|---|---|
| `browser.navigation` | Event | Dev client | A navigation happened. Emitted early, so it survives a leave before `load`. `url.full`, `browser.navigation.same_document`, `.hash_change`, `.type` (`push`, `replace`, `reload`, `traverse`) |
| `browser.navigation_timing` | Event | Dev client | `PerformanceNavigationTiming` milestones |
| `browser.resource_timing` | Event | Dev client | One per resource. Timestamp MUST be the resource start |
| `documentLoad` | Span | Draft: browser PR #504, agreed Oct 22 SIG | `fetchStart` to `loadEventEnd`, `url.full`. No children, no span events. Linked to the server trace through a meta tag in a later PR |

**Event or span (Q16): both, for different jobs.** This is what the Browser SIG agreed. The event is the reliable count of page loads. The span is what connects a page load to the backend that served it. Timing lives in events, not span children, in line with OTEP 4430. **Founder decision D2.**

Is the span redundant? Without the meta tag link, it adds only a total duration that `browser.navigation_timing` already holds, and in that case skip it. The value is the backend link.

**Span created after the fact.** The SDK reads the timing entry once `load` has fired and builds the span with explicit start and end times. There is no open span at any point. If the user leaves before `load`, there is no span, and the `browser.navigation` event still says the page was visited.

**Q19, spans open at `pagehide`.** Only in-flight fetches can still be open. Spans are exported only at end, so the SDK ends them at `pagehide` with `ouo.span.abandoned=true`. OTel has no convention; Low confidence one appears. That is the only marker we need.

## Soft navigation (Q17)

OTel has **no definition**. Its [navigation doc](https://github.com/open-telemetry/opentelemetry-browser/blob/main/docs/navigation-event.md) has a TODO and lists heuristics: user-initiated, URL change, visible content change. SIG notes say it will stay experimental longer.

**Ours.** A soft navigation is `browser.navigation` with `same_document=true` and `hash_change=false`. Hash-only changes are off by default, as the same doc recommends. We do not attempt the "content changed" heuristic in the event. An app can call a manual API, Step 3.

Prediction: the shape stays, a new discriminator or event may appear. Medium.

Attribute note: the event uses `url.full` for the navigated URL. Core's `browser.document.url.full` is for the *current document* on any record. Do not conflate them.

## Screen views on mobile

**What OTel defines.** No core event. `app.screen.name` and `.id` are Dev core attributes, and `app.screen.id` identifies a screen, not one visit to it. Android emits lifecycle spans (`Created`, `Resumed`...) with `app.screen.name` and `app.screen.previous.name`, and, for Compose, event `app.navigation.complete` with `app.navigation.destination.name` (SDK only). Swift has none.

**Event or span: event.** Lifecycle spans per transition are volume with little query value. One `app.navigation.complete` per screen matches `browser.navigation` conceptually.

**Ours.** `app.navigation.complete` on iOS, Android and React Native, with `app.navigation.destination.name` (route pattern, not filled arguments), `app.screen.name`, and `app.screen.id`. Prediction: stays as an event, could merge with a shared navigation family. Name confidence Medium.

## A view id: `ouo.view.id` — Proposed (decision D5)

Grouping events by one visit to one page or screen needs an id. Browser issue #84 is open with three candidates: `app.screen.id` (does not fit: identifies a screen, not a visit), `browser.navigation.id`, and `browser.document.id` (would not change on soft navigation). SDKs also emit `browser.web_vital.navigation_id`.

Ours: `ouo.view.id`, a new random id on every navigation, hard or soft, and on every screen view, attached to every record. Fallback: rename when #84 lands. Confidence that OTel adopts an equivalent: Medium, name Low.

Mobile foreground and background transitions are `device.app.lifecycle` (Dev core, moving in PR #51), with `android.app.state` or `ios.app.state`. Keep it as an event. Web visibility is browser issue #377, Draft.

## Trace boundaries (Q18)

One trace for the page load and the server request that rendered it. One trace per fetch or XHR after that. **Never a session-long trace.** Separate traces are joined by `session.id`. Browser issue #129 and a comment in the Browser SIG notes point the same way: only the document-load span joins the server trace, and each network request starts a new one.

## Fetch and XHR

Client HTTP spans, kind CLIENT, named by method, per the Stable HTTP conventions. Both SDKs agree. **Span**, since it is the link to the backend. Confidence High.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Page load | span `pageload` | `view` RUM event | `$pageview` |
| Soft navigation | span `navigation` | `view` RUM event | `$pageview` |
| Mobile screen | `ui.load` | `view` | `$screen` |
| Per-visit id | | `view.id` | `$pageview_id`, `$prev_pageview_id` |
| Leave | | | `$pageleave` |
| Resource | | `resource` RUM event | |

The gap: Datadog and Sentry both make the view a first-class long-lived object. OTel's model is discrete events tied together only by id, which is why `ouo.view.id` matters.
