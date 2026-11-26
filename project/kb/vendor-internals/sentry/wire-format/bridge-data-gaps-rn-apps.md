# What a React Native app on the Sentry SDK alone does not give ouo through the bridge

Found on 2026-11-15 while mapping a RUM plugin design onto a real React Native app that keeps its Sentry SDK unchanged (bare React Native 0.86, Hermes, `@sentry/react-native` 7.7.0 with `@sentry/core` 10.26.0, sentry-cocoa 8.57.3, sentry-android 8.27.0, 100% sessions, traces and replays). Checked against the SDK sources (npm tarballs), the app's events and replays in its Sentry, and `collector/receiver/ouosentryreceiver` at `a8301a00`. Facts, not decisions.

## SDK behaviour that decides what reaches ouo

| # | Fact | Source |
|---|---|---|
| S1 | Without `reactNavigationIntegration` (and `registerNavigationContainer`), React Native sends no navigation transactions and no navigation breadcrumbs. `contexts.app.view_names` is not set by the JS layer, and the native replay names every screen `UIViewController` on iOS. So the bridge has no screen names: no `navigation` records, no `ouo.app.screen` on errors, no `ouo.screen.display` | observed on real events and replays; spec sections 6a, 7, 9a |
| S2 | Same symptom as the [compatibility, 7.11.0 row](../../../../../docs/compatibility.md#sentry-sdks-through-the-bridge) (no `http.client` spans), different cause: `@sentry/browser` 10.26.0 creates an XHR span only when a span is active (`shouldCreateSpanResult && hasParent`). Without navigation tracing almost no request gets one, so the span-derived records (`http.request.failed`, `http.request` for sessions without replay) are missing | SDK source `tracing/request.js` |
| S3 | `enableUserInteractionTracing` creates nothing unless elements carry `sentry-label` (`elementId` undefined → no transaction) | `tracing/integrations/userInteraction.js` |
| S4 | No `traceparent`, as in the [compatibility, 7.11.0 row](../../../../../docs/compatibility.md#sentry-sdks-through-the-bridge): `propagateTraceparent` is off by default (`@sentry/core` 10.26.0 supports `true`), and an OTel backend with the W3C propagator ignores `sentry-trace`. The default `tracePropagationTargets` is `[/.*/]`, so headers go to every host | `tracing/reactnativetracing.js` l.8-13, `@sentry/core` `utils/traceData.js` |

## Bridge gaps this exposes

| # | Gap | Size |
|---|---|---|
| B1 | Failed requests (status 0 or >= 500) are taken only from `http.client` spans (`breadcrumbs.go`, comment above `code == 0 || code >= 500`). An app without spans (S2) shows timeouts and network errors only as exceptions, never as timeline requests | S: emit `http.request.failed` from a breadcrumb that has no `__span` |
| B2 | Breadcrumb `http.request` records carry no duration, although the breadcrumbs have start and end times | XS |
| B3 | Custom business events cannot be funnel `event` steps: Sentry log entries become `event.name = log`, breadcrumbs `breadcrumb` ([funnels spec](../../../../../docs/specs/funnels.md)) | S: map a chosen log attribute or breadcrumb category to a custom `event.name` |
| B4 | Tags reach ouo only on errors (`copy_tags`); sessions carry none, so a per-tag crash-free rate (for example per OTA bundle) is impossible | S: stamp the session's last seen tag on `session.end` |
| B5 | Issue grouping and short ids are assigned by Sentry's server; the bridge has only `ouo.sentry.event_id`. History before go-live is absent | needs Sentry's API ([read-apis](../read-apis/index.md)) |
| B6 | `@sentry/react-native` 7.7.0 on React Native 0.86 and every Android payload are outside the captured golden journeys ([compatibility](../../../../../docs/compatibility.md#sentry-sdks-through-the-bridge)) | capture before relying on it |

Also noted: 7.7.0 still honours `_experiments.replaysSessionSampleRate` / `replaysOnErrorSampleRate` (`integrations/default.js` l.91-97); every `Sentry.init` option above ships over the air with an OTA updater, the DSN and SDK upgrades do not; video replays recorded with masking off cannot be masked later (ouo can only say `masked = false`); one Sentry project for iOS and Android gives one `service.name`, so platform splits use the resource `os.name`.

Open question: 7.x attaches app start to the first root span, so with no navigation tracing it is probably never sent. Check with a capture.

## What still works without any app change

Sessions and crash-free rates per release and OS, fatal and handled errors with device context, user ids (numeric after login, the installation id before), video replays, and, because the replay recording carries every fetch breadcrumb (spec 9a), every answered request of each replayed session with method, URL and status. Taps arrive as component paths (`ScrollView > View > Pressable`), not names.
