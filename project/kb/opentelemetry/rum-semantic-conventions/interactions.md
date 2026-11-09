# RUM conventions: clicks and taps

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## What OTel defines

| Platform | Name | Status | Coordinates and target |
|---|---|---|---|
| Web | Event `browser.user_action.click` | SDK only. Core PR #2992 closed stale | `browser.page.x`, `.y`, `browser.tag_name`, `browser.css_selector`, `browser.mouse_event.button`, `browser.element.attributes` (only `data-otel-*`) |
| Mobile | Event `app.screen.click` | Dev core | `app.screen.coordinate.x`, `.y` required, **absolute screen pixels**. `app.screen.id` recommended, `.name` opt-in |
| Mobile | Event `app.widget.click` | Dev core | `app.widget.id` required, `.name` and coordinates opt-in |
| Android extras | `app.screen.longpress`, `.scroll`, `.fling`, and `app.widget.*` versions | SDK only | `hw.pointer.*` |

Client-side #34 lists "shared click events" as an open decision. Semantic-conventions #3592 proposes a log-based, replay-adjacent event set for mobile, with no draft yet.

## Event or span (Q13, Q14)

**Event.** The OTel browser model says user interactions "will be captured as point-in-time events", because browsers have no context propagation without Zone.js. A settle-time duration is a heuristic with no defined end. INP already measures the interaction's latency.

**A click does not start a trace (Q14).** Each fetch has its own trace. The join between a click and its fetches is by `session.id` and time. Should the TC39 AsyncContext proposal land, this can be revisited. So head sampling of backend calls cannot be driven by clicks; see [sessions entry](sessions.md).

## One model across web and mobile (Q15)

Not yet. Keep each platform's name, and make the shape equal so that one query can cover both: the same `session.id` and `ouo.view.id`, and coordinates and target always present when known. When #34 settles, the rename table converges them. Prediction: a shared click event family. Medium on existence, Low on name.

**Android sends two events for one tap on a widget** (`app.screen.click` then `app.widget.click`). We should send one: `app.widget.click` when the target is known, otherwise `app.screen.click`. Coordinates are opt-in on the widget event, but we always include them for heatmaps. This is allowed by the convention, and differs from Android's implementation.

**Coordinate units differ.** Web is CSS pixels relative to the page. Mobile is absolute screen pixels. A heatmap must normalise by scroll and viewport, which needs `ouo.viewport.width` and `.height`. Step 3 decides whether those live on the click or the view.

React Native: use `app.*`, not `browser.*`. It is a mobile app. RN coordinates are density-independent points, so they must be scaled to pixels to meet the convention.

## Rage and dead clicks

**What OTel defines.** Nothing. Browser issue #510 (open, with a volunteer) proposes rage (4+ clicks within about 1000 ms on the same element), dead (no DOM change, navigation or network within about 2000 ms), and error (click followed by an error). It lists two shapes: one event per type, or a single event with a discriminator.

**Event or span: event.** A derived, instantaneous fact.

**Why detect in the SDK.** Dead clicks need a MutationObserver, so the server cannot detect them. Rage could be server-derived from clicks, but one code path is simpler.

**Ours.** One event `ouo.user_action.frustration`, with `ouo.user_action.frustration.type` = `rage`, `dead` or `error`, and `ouo.user_action.frustration.click_count` for rage. It carries the same target attributes as the click, and is emitted **in addition** to the clicks, not instead. Mobile: same event, with `rage` and `dead` applying to taps.

Prediction: the namespace becomes `browser.user_action.*`. Discriminator or per-type: unknown. Confidence Low. Fallback: rename table.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Click | breadcrumb `ui.click`, mobile span `ui.action.click` | `action` RUM event | `$autocapture` |
| Rage | replay breadcrumb `ui.multiClick` | `rage_click` / mobile `rage_tap` | `$rageclick` |
| Dead | replay breadcrumb `ui.slowClickDetected` | `dead_click` | `$dead_click` |
| Error | | `error_click` / `error_tap` | |

## Privacy

`browser.css_selector`, element text and `app.widget.name` can carry user data. Client-side #35 raises the same concern for INP targets. Step 3 sets the defaults. We never put element text in by default.
