# RUM conventions: propagation, resources and entities

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## `traceparent`, client to backend

The OTel browser SDK uses W3C Trace Context and W3C Baggage propagators by default. Fetch and XHR inject on same-origin requests automatically, and cross-origin only for URLs matched by `propagateTraceHeaderCorsUrls`. A cross-origin API must allow the `traceparent` header in CORS, or the preflight fails. Mobile HTTP clients inject with no CORS concern.

Known issue: fetch replaces an existing `traceparent`, while XHR appends and so can produce an invalid header (browser issue #518, undecided). The SDK must skip injection when one is already set.

## Backend to client, for the page load

No standard. The old mechanism is a `<meta name="traceparent">` tag. A proposal to use `Server-Timing` (specification #3811) is stalled. The Oct 22 Browser SIG plan is to link the `documentLoad` span to the server context **through the meta tag**, in a later PR. Browser issue #129 argues it should apply only to document load, not to later events. We follow that.

## `session.id` to the backend

**Draft.** Browser issue #535 (from the Oct 29 SIG): opt-in, off by default, sent in W3C baggage as `session.id`, only to URLs that already get trace headers, and the same value as the span's attribute.

```http
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
baggage: session.id=00112233-4455-6677-8899-aabbccddeeff
```

Costs: the backend must copy baggage to a span attribute itself; CORS must also allow `baggage`; the id reaches every service in the path.

**Ours: baggage, off by default, same rules as #535, and the same name. Founder decision D4.** It is what lets a backend trace be found from a session, which is core to the product, and it is the OTel direction. Confidence High that baggage is the mechanism.

## Resource versus record attributes (Q1)

Rule from [Step 1](../storage-backends/signal-choice-and-backends.md): low-cardinality identity on the resource, anything that changes or varies per user on records. Backends promote resources: Loki indexes `service.instance.id`; VictoriaLogs and VictoriaMetrics promote everything by default.

| Attribute | Where | Web | Mobile | Status | Note |
|---|---|---|---|---|---|
| `service.name`, `service.version` | Resource | Yes | Yes | Stable | App identity |
| `deployment.environment.name` | Resource | Yes | Yes | | |
| `telemetry.sdk.*` | Resource | Yes | Yes | Stable | |
| `service.instance.id` | **Do not set** | | | | Loki would create one stream per tab or device |
| `browser.brands`, `.platform`, `.mobile`, `.language` | Resource | Yes | | Dev core | No browser entity yet; identity under discussion (client-side #34) |
| `user_agent.original` | Resource or omit | Yes | | | Long, and rarely needed if brands are present |
| `browser.document.url.full` | **Record** | Yes | | Dev core | Defined as an entity attribute, but it changes on soft navigation |
| `app.build_id` | Resource | | Yes | Dev core | Identifying attribute of the `app` entity. Required for symbolication |
| `app.installation.id` | **Record, or off** | | Yes | Dev core | Android puts it on the resource. One value per install; do not |
| `device.model.identifier`, `.manufacturer`, `.model.name` | Resource | | Yes | Dev core | Bounded |
| `device.id` | **Off** | | | Dev core | Opt-in in core. Privacy |
| `os.name`, `os.version`, `android.os.api_level` | Resource | Yes | Yes | | |
| `session.id` | **Record** | Yes | Yes | Dev core | [Sessions entry](sessions.md) |
| `ouo.view.id`, `app.screen.name` | **Record** | Yes | Yes | | Change during the SDK's life |
| `enduser.id`, `enduser.pseudo.id` | Record, opt-in | Yes | Yes | Dev client | Moved to client-side |

**Founder decision D4 covers the three "do not" rows** because they diverge from what the OTel SDKs do.

## Entities

Entities let a resource change identity. They are the planned home for session and document. Today:

- `browser.document` (identifying: `browser.document.url.full`) and `app` (identifying: `app.build_id`, descriptive: `app.installation.id`) exist as Dev core.
- `android` was removed as an entity in 1.45.0 in favour of an attribute group.
- A `browser.session` entity exists only in demo PR #269.
- URL as entity identity is unresolved. The query string changes constantly, and the browser roadmap lists its cardinality as an open question.
- Client-side #34: the SIG has not decided whether "browser" means a kind of browser or one running instance.

**Do not build on entities yet.** Use record attributes and move later through the rename table. Prediction: `session` and `browser.document` end up as entities, Medium, not before the entity spec is stable.

## URL handling

The browser SDK has a `sanitizeUrl` hook, and issues #466 and #475 show it still misses query-shaped fragments. PR #472 is fixing signed parameters. URLs carry tokens, so sanitising by default is a Step 3 requirement, on `url.full`, `browser.document.url.full` and replay.
