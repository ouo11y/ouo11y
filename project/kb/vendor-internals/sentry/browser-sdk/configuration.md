# Sentry browser SDK: every configuration option

- SDK version: `@sentry/browser` 11.11.0 (2026-11-05) and `@sentry/react` 11.11.0. Compared with 10.78.0.
- Research date: 2026-11-10.
- `B` = https://github.com/getsentry/sentry-javascript/blob/11.11.0
- `B10` = https://github.com/getsentry/sentry-javascript/blob/10.78.0
- `MIG` = `B/MIGRATION.md` (section "Upgrading from 10.x to 11.x").
- The feature-level view is in Step 4: [`../../../client-sdk-features/vendors/sentry-web.md`](../../../client-sdk-features/vendors/sentry-web.md). This file goes one level deeper: every option, its real default, and where the default is applied. It does not repeat the feature lists.
- Every row is "(code)" unless marked otherwise. "(code, MIG)" means the statement comes from the repo's MIGRATION.md at the tag. No docs.sentry.io page was needed; no row is "(docs)".
- "Default" is the value the code applies, found by reading where the option is consumed. When the JSDoc disagrees with the code, the row says so.

## How defaults are applied (read this first)

1. `init()` in `B/packages/browser/src/sdk.ts#L97-L131`: disables the SDK inside browser extensions (L98-99), picks default integrations (L101-102), adds Spotlight only in development builds (L104-112), resolves the managed tunnel (L121), forces `enabled: false` in extensions (L122), default stack parser (L123), default transport `makeFetchTransport` (L125).
2. `applyDefaultOptions()` in `B/packages/browser/src/client.ts#L241-L251`: `release` from `__SENTRY_RELEASE__` or `window.SENTRY_RELEASE.id`, `sendClientReports: true`, `parentSpanIsAlwaysRootSpan: true`. User options override these.
3. Core `Client` constructor in `B/packages/core/src/client.ts#L262-L327`: `attachStacktrace: true` (L265), `traceLifecycle` normalised to `'stream'` unless exactly `'static'` (L267), transport buffer 64 (L274), `dataCollection` resolved (L275), log and metric flushing set up (L318-326).
4. `dataCollection` defaults in `B/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts#L8-L21`.
5. Everything else is read lazily with `??`/`||` fallbacks at the point of use (rows below cite that line).

## Core options

Interface: `ClientOptions` `B/packages/core/src/types/options.ts#L149-L637`, `CoreOptions` `#L687-L724`. `ServerRuntimeOptions` (`#L20-L85`: `serverName`, `includeServerName`, `shutdownTimeout`, `clientReportFlushInterval`, `onFatalError`) does not apply to the browser.

| Option | Type | Default (applied) | Effect | Source |
|---|---|---|---|---|
| `dsn` | string | not set (undefined). Without it no transport is built and nothing is sent. | Ingest target. Also the source of `org_id` (parsed from host `oNNN.ingest...`). | `B/packages/core/src/types/options.ts#L192`; `B/packages/core/src/client.ts#L279-L283`, `#L303-L314` |
| `debug` | boolean | `false` | SDK logs to console. Only effective in debug builds. | `options.ts#L156` |
| `enabled` | boolean | `true` (anything but `false`). Forced `false` inside a browser extension unless `skipBrowserExtensionCheck`. | Gate on sending. Instrumentation still runs. | `options.ts#L165`; `B/packages/core/src/client.ts#L1446`; `B/packages/browser/src/sdk.ts#L122` |
| `release` | string | `__SENTRY_RELEASE__` build constant, else `window.SENTRY_RELEASE.id`, else undefined | Stamped on events, sessions, logs (`sentry.release`), metrics. Sessions are not sent without it. | `options.ts#L202`; `B/packages/browser/src/client.ts#L243-L246` |
| `environment` | string | `"production"` if unset or empty | Stamped on events, logs, sessions. | `options.ts#L212`; `B/packages/core/src/utils/prepareEvent.ts#L168`; `B/packages/core/src/constants.ts#L1` |
| `dist` | string | not set (undefined) | Build variant. | `options.ts#L220`; `prepareEvent.ts#L174-L176` |
| `attachStacktrace` | boolean | `true` (new in v11; v10 default `false`) | Synthetic stack on `captureMessage` and non-Error `captureException`. v11 consequence: such events mark the release-health session as errored. | `options.ts#L177`; `B/packages/core/src/client.ts#L265`; MIG `attachStacktrace defaults to true` (code, MIG) |
| `sampleRate` | number 0..1 | undefined = send all errors (doc says 1.0) | Random drop of error events only (not transactions/spans). | `options.ts#L294`; `B/packages/core/src/client.ts#L1559-L1583` |
| `tracesSampleRate` | number | not set (undefined). Tracing is off unless this or `tracesSampler` is set. | Head sampling for root spans. | `options.ts#L256`; `B/packages/core/src/utils/hasSpansEnabled.ts#L23-L34` |
| `tracesSampler` | fn(ctx) => number\|boolean | not set | Overrides `tracesSampleRate`. `ctx.attributes` is always present in v11. | `options.ts#L571`; MIG section 6 |
| `traceLifecycle` | `'static'`\|`'stream'` | `'stream'` (v10 default `'static'`) | `'stream'`: spans sent in batches as `span` v2 items. `'static'`: legacy transaction events. | `options.ts#L510`; `B/packages/core/src/client.ts#L267`; `B10/packages/core/src/types/options.ts#L555` |
| `parentSpanIsAlwaysRootSpan` | boolean | `true` in browser | New spans parent to the active root span, not the active child, because browser async context is unreliable. | `options.ts#L269`; `B/packages/browser/src/client.ts#L249` |
| `initialScope` | CaptureContext | not set | Applied to the scope at init. | `options.ts#L276`; `B/packages/core/src/sdk.ts#L36` |
| `maxBreadcrumbs` | number | `100`. `<= 0` disables breadcrumbs. | Ring buffer size on the isolation scope. | `options.ts#L284`; `B/packages/core/src/breadcrumbs.ts#L12`, `#L26-L28` |
| `maxValueLength` | number | not set (undefined) = **no truncation** | Truncates `request.url` and `exception.value` only; also passed to `extraErrorDataIntegration`. | `options.ts#L299`; `B/packages/core/src/utils/prepareEvent.ts#L164-L190` |
| `normalizeDepth` | number | `3` | Depth for normalising `breadcrumbs.data`, `user`, `contexts`, `extra`; also console-log attributes. | `options.ts#L311`; `prepareEvent.ts#L54`; `B/packages/core/src/logs/console-integration.ts#L29` |
| `normalizeMaxBreadth` | number | `1000` | Max keys/items per object/array during normalisation. | `options.ts#L323`; `prepareEvent.ts#L54` |
| `ignoreErrors` | (string\|RegExp)[] | `[]` plus 12 built-in patterns (see eventFilters) | Drops error events by message. Needs `eventFiltersIntegration`. | `options.ts#L334`; `B/packages/core/src/integrations/eventFilters.ts#L12-L26`, `#L77-L81` |
| `ignoreTransactions` | (string\|RegExp)[] | `[]`. Deprecated. No-op under `traceLifecycle:'stream'`. | Drops transaction events by name (static only). | `options.ts#L354` |
| `ignoreSpans` | (string\|RegExp\|{name?,op?,attributes?})[] | `[]` | Under streaming, matching spans are not recorded at start (`trace.ts`); under static, dropped from the transaction at send. Attribute matcher: strings by substring/RegExp, others strict equality. | `options.ts#L87-L147`, `#L365`; `B/packages/core/src/tracing/trace.ts#L636-L650`; `B/packages/core/src/client.ts#L1803-L1836` |
| `allowUrls` | (string\|RegExp)[] | `[]` | Keep only errors whose top frame URL matches. Needs eventFilters. | `options.ts#L433` |
| `denyUrls` | (string\|RegExp)[] | `[]` | Drop errors whose top frame URL matches. Needs eventFilters. | `options.ts#L445` |
| `beforeSend` | (ErrorEvent, hint) => event\|null (async allowed) | not set | Last hook for error/message events. | `options.ts#L584` |
| `beforeSendTransaction` | (TransactionEvent, hint) | not set. Deprecated. Runs only with `traceLifecycle:'static'`. | | `options.ts#L620` |
| `beforeSendSpan` | (StreamedSpanJSON) => StreamedSpanJSON | not set. Cannot drop a span (must return one). For `'static'` wrap with `withStaticSpan`; a mismatch is silently ignored (debug warning). | Mutate span payload before send. | `options.ts#L599`, `#L644-L653`; `B/packages/core/src/client.ts#L285-L301` |
| `beforeBreadcrumb` | (Breadcrumb, hint) => Breadcrumb\|null | not set | Mutate or drop breadcrumbs. | `options.ts#L636`; `breadcrumbs.ts#L26` |
| `beforeSendLog` | (Log) => Log\|null | not set | Last hook for logs. | `options.ts#L532`; `B/packages/core/src/logs/internal.ts#L100`, `#L159-L174` |
| `beforeSendMetric` | (Metric) => Metric\|null | not set (moved from `_experiments` in v11) | Last hook for metrics. | `options.ts#L558`; `B/packages/core/src/metrics/internal.ts#L187-L211` |
| `_flushInterval` | number (ms), @internal | `5000`. `0` disables timer flush. | Idle flush timer for logs and metrics buffers. | `options.ts#L544`; `B/packages/core/src/client.ts#L69`, `#L164` |
| `tracePropagationTargets` | (string\|RegExp)[] | not set. Browser: same-origin requests only (relative URLs, or same origin when `location.origin` is known). Matching is case-insensitive in v11; `g`/`y` flags ignored. | Which outgoing fetch/XHR get `sentry-trace` + `baggage`. | `options.ts#L475`; `B/packages/browser/src/tracing/request.ts#L276-L305`; `B/packages/browser/src/tracing/browserTracingIntegration.ts#L743`; MIG `tracePropagationTargets matching is now case-insensitive` |
| `propagateTraceparent` | boolean | `false` | Also send W3C `traceparent` to the same targets. | `options.ts#L489`; `request.ts#L150`; `B/packages/core/src/fetch.ts#L101`, `#L226` |
| `strictTraceContinuation` | boolean | `false` | Only continue an incoming trace when baggage `org_id` matches. | `options.ts#L502`; `B/packages/core/src/utils/tracing.ts#L175` |
| `orgId` | `${number}`\|number | not set; derived from DSN host | Used for propagation (`sentry-org_id` in baggage) and strict continuation. | `options.ts#L518`; `B/packages/core/src/utils/dsn.ts#L141-L151` |
| `tunnel` | string \| `true` \| `{path?, basePath?, trailingSlash?}` | not set | String: send envelopes to that URL. `true`/object: same-origin path derived from the DSN, served by a server SDK's `serveTunnelIntegration`. | `options.ts#L655-L697`; `B/packages/browser/src/client.ts#L103`; `B/packages/browser/src/utils/managedTunnel.ts#L15-L40` |
| `_managedTunnel` | ServerTunnelOptions, @internal | not set | Server side only. | `options.ts#L381` |
| `transport` | (opts) => Transport | `makeFetchTransport` | `fetch` POST, `referrerPolicy: 'strict-origin'`, `keepalive` while pending bodies <= 60 000 bytes and < 15 requests. | `options.ts#L233`, `#L717`; `B/packages/browser/src/sdk.ts#L125`; `B/packages/browser/src/transports/fetch.ts#L24-L40` |
| `transportOptions.headers` | Record<string,string> | not set | Extra HTTP headers on envelope POSTs. | `B/packages/core/src/types/transport.ts#L37` |
| `transportOptions.bufferSize` | number | `64` | Max concurrent in-flight envelopes; extra ones are dropped (client report `queue_overflow`). | `transport.ts#L24`; `B/packages/core/src/client.ts#L274`; `B/packages/core/src/transports/base.ts#L22` |
| `transportOptions.fetchOptions` | RequestInit | not set | Merged into the fetch call. | `B/packages/browser/src/transports/types.ts#L3-L6` |
| `stackParser` | StackParser \| StackLineParser[] | `defaultStackParser` (chrome, gecko, winjs; opera parsers exported but not default) | Stack frame parsing. Frames capped at 50. | `options.ts#L723`; `B/packages/browser/src/sdk.ts#L123`; `B/packages/core/src/utils/stacktrace.ts#L6` |
| `integrations` | Integration[] \| (defaults) => Integration[] | `[]` added to defaults | User integrations; function form can filter defaults. | `options.ts#L710` |
| `defaultIntegrations` | false \| Integration[] | browser default list (next section) | `false` removes all defaults. | `options.ts#L703`; `B/packages/browser/src/sdk.ts#L101-L102` |
| `sendClientReports` | boolean | `true` (browser) | Sends outcome counts of dropped data; browser flushes them on `visibilitychange` hidden. | `options.ts#L185`; `B/packages/browser/src/client.ts#L247`, `#L173-L176` |
| `enhanceFetchErrorMessages` | `'always'`\|`'report-only'`\|false | `'always'` | Appends hostname to "Failed to fetch" style errors, mutating the real error. | `options.ts#L405`; `B/packages/core/src/instrument/fetch.ts#L127` |
| `spotlight` | boolean\|string | not set. Code is stripped from production builds. | Adds `spotlightBrowserIntegration` (sidecar `http://localhost:8969/stream`). | `B/packages/browser/src/client.ts#L82`; `B/packages/browser/src/sdk.ts#L104-L112` |
| `_metadata` | SdkMetadata, @internal | set by SDK (`sdk.name`, packages, `settings.infer_ip`) | Envelope header metadata. | `options.ts#L413`; `B/packages/browser/src/client.ts#L127`, `#L140-L147` |
| `_experiments` | `{[key]: any}` | `{}`. In 11.11.0 neither core nor browser reads any key (grep). v10 typed keys `enableLogs`, `enableMetrics`, `beforeSendMetric` were removed. | Reserved. | `options.ts#L418-L421`; `B10/packages/core/src/types/options.ts#L433-L470` |

### `dataCollection` sub-keys

Type: `B/packages/core/src/types/datacollection.ts#L26-L141`. Defaults: `B/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts#L8-L21`. `CollectBehavior` = `true` (collect all, built-in sensitive-key filter still applies) \| `false` \| `{allow: string[]}` \| `{deny: string[]}` (`datacollection.ts#L9`).

| Sub-key | Type | v11 default | Browser effect | Source |
|---|---|---|---|---|
| `userInfo` | boolean | `true` | Sets `_metadata.sdk.settings.infer_ip: 'auto'`; adds `ingest_settings {infer_ip, infer_user_agent: 'auto'}` to log, metric and span envelopes; adds auto IP to sessions. So Relay derives client IP and UA by default. | `resolveDataCollectionOptions.ts#L9`; `B/packages/browser/src/client.ts#L138-L147`, `#L202-L204`; `B/packages/core/src/logs/envelope.ts#L9-L24`; `B/packages/core/src/tracing/spans/envelope.ts#L39-L45` |
| `cookies` | CollectBehavior | `true` | `httpClientIntegration` attaches request `Cookie` / response `Set-Cookie` (filtered by sensitive name list). | `#L10`; `B/packages/browser/src/integrations/httpclient.ts#L82-L100` |
| `httpHeaders` | CollectBehavior \| `{request?, response?}` | `{request: true, response: true}` | `httpContextIntegration` request headers (User-Agent, Referer); `httpClientIntegration` headers. Sensitive keys always replaced with `[Filtered]`. | `#L11`; `B/packages/browser/src/integrations/httpcontext.ts#L26-L39`; `B/packages/core/src/utils/data-collection/filtering-snippets.ts#L1-L25` |
| `httpBodies` | ('incomingRequest'\|'outgoingRequest'\|'incomingResponse'\|'outgoingResponse')[] | all four | Server-side body capture. Not used by browser core integrations (replay has its own `networkCaptureBodies`). | `#L12` |
| `urlQueryParams` | CollectBehavior | `true` | Query strings on breadcrumb URLs, `url.full` span attributes, `event.request.url` pass through `filterCollectedUrl` (sensitive keys filtered). | `#L13`; `B/packages/core/src/utils/data-collection/filterCollectedUrl.ts` |
| `graphQL.document` / `.variables` | boolean | `true` / `true` | `graphqlClientIntegration` payload on spans/breadcrumbs. | `#L14` |
| `genAI.inputs` / `.outputs` | boolean | `true` / `true` | AI integrations (server). | `#L15` |
| `mcp.inputs` / `.outputs` | boolean | `true` / `true` (new in v11) | MCP server instrumentation. | `#L16` |
| `databaseQueryData` | boolean | `true` | Server DB/Supabase payloads. | `#L17` |
| `queues` | boolean | `true` (new in v11) | Server queue task args. | `#L18` |
| `stackFrameVariables` | boolean \| CollectBehavior | `true` | Server local variables. | `#L19` |
| `frameContextLines` | number | `5` | Lines of HTML context per frame in `contextLinesIntegration`. | `#L20`; `B/packages/browser/src/integrations/contextlines.ts#L27` |

## Browser-only options

`BrowserOptions` = `CoreOptions` + `BrowserSpecificOptions` (`B/packages/browser/src/client.ts#L48-L104`) + replay sample rates (`B/packages/core/src/types/browseroptions.ts`).

| Option | Type | Default | Effect | Source |
|---|---|---|---|---|
| `skipBrowserExtensionCheck` | boolean | `false` | When `false` and `init` runs inside an extension, the SDK sets `enabled:false` and warns. | `B/packages/browser/src/client.ts#L70`; `B/packages/browser/src/sdk.ts#L98-L99`, `#L122` |
| `cdnBaseUrl` | string | `https://browser.sentry-cdn.com` | Base URL for `lazyLoadIntegration`. | `client.ts#L51`; `B/packages/browser/src/utils/lazyLoadIntegration.ts#L114` |
| `routeProvider` | RouteProvider (new in v11) | not set; framework SDKs set it | Maps URLs to low-cardinality route names for span names and bfcache metrics. | `client.ts#L90`, `#L131-L133` |
| `spotlight` | boolean\|string | not set | See core table. | `client.ts#L82` |
| `tunnel` | `TunnelInit<BrowserTunnelOptions>` | not set | See core table; adds `trailingSlash`. | `client.ts#L103` |
| `replaysSessionSampleRate` | number | not set -> 0 | Fraction of sessions recorded from start. | `B/packages/core/src/types/browseroptions.ts#L10`; `B/packages/replay-internal/src/integration.ts#L424-L452` |
| `replaysOnErrorSampleRate` | number | not set -> 0 | Fraction of sessions that buffer and send on error. Both unset -> replay disabled with a console warning. | `browseroptions.ts#L17`; `integration.ts#L424-L452` |
| `profileSessionSampleRate` | number | `0` (no profiling) | Per page-load sampling for UI profiling. | `client.ts#L33`; `B/packages/browser/src/profiling/utils.ts#L292-L306` |
| `profileLifecycle` | `'manual'`\|`'trace'` | `'manual'` | `'trace'`: profiler runs while sampled root spans exist. `'manual'`: `Sentry.uiProfiler.start/stop`. | `client.ts#L45`; `B/packages/browser/src/profiling/integration.ts#L17-L24` |
| `sendClientReports` | | `true` | See core. | `client.ts#L247` |
| `parentSpanIsAlwaysRootSpan` | | `true` | See core. | `client.ts#L249` |
| `propagateTraceparent` | | `false` | Core option; read by browser request instrumentation. | `B/packages/browser/src/tracing/request.ts#L150` |

Not configurable but always on in the browser client: flush of logs, metrics and span buffers plus client reports on `visibilitychange` -> hidden (deferred one microtask); clock-drift checks on `freeze`/`resume`/`pagehide`/`pageshow`; unhandled errors set the session to `unhandled`, not `crashed` (`B/packages/browser/src/client.ts#L135-L200`).

## Default integrations

List: `B/packages/browser/src/sdk.ts#L30-L49`. Order matters for event processors.

| Integration (name) | What it does | Options and defaults | Source |
|---|---|---|---|
| `eventFiltersIntegration` (`EventFilters`) | Drops events by `ignoreErrors`, `allowUrls`, `denyUrls`, `ignoreTransactions`, SDK-internal errors. Built-in ignore list (12 RegExps: "Script error.", ResizeObserver loop, googletag, gmo, solana, GTM, Instagram autofill, CEFSharp, Facebook Java errors). Renamed from `InboundFilters`. | `allowUrls []`, `denyUrls []`, `ignoreErrors []`, `ignoreTransactions []`, `ignoreInternal` (true unless false), `disableErrorDefaults false`. Merged with client options. | `B/packages/core/src/integrations/eventFilters.ts#L12-L34`, `#L70-L85` |
| `functionToStringIntegration` | Makes wrapped functions' `toString` return the original source. | none | `B/packages/core/src/integrations/functiontostring.ts` |
| `conversationIdIntegration` | Copies scope `conversationId` (`Sentry.setConversationId`) to `gen_ai.*` spans as `gen_ai.conversation.id`. | none | `B/packages/core/src/integrations/conversationId.ts#L11-L37` |
| `browserApiErrorsIntegration` | Wraps `setTimeout`, `setInterval`, `requestAnimationFrame`, XHR callbacks, `EventTarget.addEventListener` so thrown errors get a mechanism and better stacks. | `setTimeout true`, `setInterval true`, `requestAnimationFrame true`, `XMLHttpRequest true`, `eventTarget true` (or string[] of targets), `unregisterOriginalCallbacks false` | `B/packages/browser/src/integrations/browserapierrors.ts#L14-L41` |
| `breadcrumbsIntegration` | Breadcrumbs for DOM click/keypress, fetch, XHR, history, and Sentry's own sent events. v11 removed the `console` option. | `dom true` (or `{serializeAttribute, maxStringLength}`; `maxStringLength` capped at 1024), `fetch true`, `history true`, `sentry true`, `xhr true` | `B/packages/browser/src/integrations/breadcrumbs.ts#L36-L61`, `#L128-L137` |
| `consoleIntegration` (`Console`) | Console breadcrumbs (new default in v11 browser). | `levels`: all `CONSOLE_LEVELS` (debug, info, warn, error, log, assert, trace); `filter` (string\|RegExp)[]: suppresses matching messages from handlers and from the real console. | `B/packages/core/src/integrations/console.ts#L11-L64` |
| `globalHandlersIntegration` | `window.onerror` and `onunhandledrejection` capture, `handled:false`. | `onerror true`, `onunhandledrejection true` | `B/packages/browser/src/integrations/globalhandlers.ts#L27-L31` |
| `linkedErrorsIntegration` | Follows `error.cause` chains into `exception.values`. | `key 'cause'`, `limit 5` | `B/packages/browser/src/integrations/linkederrors.ts#L5-L17` |
| `dedupeIntegration` | Drops an event identical to the previous one (message, exception, stack, fingerprint). | none | `B/packages/core/src/integrations/dedupe.ts` |
| `httpContextIntegration` | Adds `request.url` (query filtered) and request headers (User-Agent, Referer) to events and spans. | none; governed by `dataCollection.httpHeaders.request` and `urlQueryParams` | `B/packages/browser/src/integrations/httpcontext.ts#L15-L45` |
| `cultureContextIntegration` | Adds `contexts.culture` (locale, timezone, calendar from `Intl`). | none | `B/packages/browser/src/integrations/culturecontext.ts` |
| `browserSessionIntegration` | Release-health sessions. | `lifecycle: 'page'` (v10 default `'route'`) | `B/packages/browser/src/integrations/browsersession.ts#L6-L26`; `B10/packages/browser/src/integrations/browsersession.ts#L28` |

Added lazily, not in the list: `spanStreamingIntegration` is added on the first `startSpan*` call or by `browserTracingIntegration` when `traceLifecycle` is `'stream'` (`B/packages/core/src/tracing/browserSpanApi.ts#L32-L41`). Option `flushOnSegmentEnd: true` (flush a trace 500 ms after its segment span ends). Buffer: per-trace timer 5000 ms, max 1000 spans per envelope, 5 MB per trace (`B/packages/core/src/integrations/spanStreaming.ts#L13-L63`; `B/packages/core/src/tracing/spans/spanBuffer.ts#L15-L17`, `#L76-L84`).

## Opt-in integrations

### browserTracingIntegration

Interface `B/packages/browser/src/tracing/browserTracingIntegration.ts#L59-L275`; defaults `#L277-L292` (+ `TRACING_DEFAULTS` `B/packages/core/src/tracing/idleSpan.ts#L26-L30`, request defaults `B/packages/browser/src/tracing/request.ts#L122-L126`). Path prefix below: `BTI` = that file.

| Option | Default | Effect | Source |
|---|---|---|---|
| `idleTimeout` | `1000` ms | Idle span ends after this long with no new child span. | `BTI#L66`; `idleSpan.ts#L27` |
| `finalTimeout` | `30000` ms | Hard cap on pageload/navigation span. | `BTI#L74`; `idleSpan.ts#L28` |
| `childSpanTimeout` | `15000` ms | Max time a child may keep the idle span open. | `BTI#L82`; `idleSpan.ts#L29` |
| `instrumentPageLoad` | `true` | Pageload span. Under streaming its initial name is the constant `"Pageload"` until a route provider names it. | `BTI#L89`, `#L655-L664`; `B/packages/core/src/tracing/spans/spanNames.ts#L25` |
| `instrumentNavigation` | `true` | Navigation span on history changes. | `BTI#L96` |
| `instrumentBfcacheRestore` | `true` (new in v11) | Navigation span when restored from bfcache. | `BTI#L109` |
| `markBackgroundSpan` | `true` | Ends active span with `documentHidden` and flushes when tab hides. | `BTI#L118` |
| `enableLongTask` | `true` | Long-task child spans. | `BTI#L125` |
| `enableLongAnimationFrame` | `true` in code (JSDoc says false) | LoAF child spans when supported; replaces long tasks then. | `BTI#L132`, `#L284` |
| `enableInp` | `true`; deprecated -> `webVitals.ignore:['inp']` | INP reporting. | `BTI#L141` |
| `webVitals` | `{}` -> `ignore []`, `softNavigations true`, `bfcacheNavigations true` | Options for the auto-registered `webVitalsIntegration` (ignored if you add your own). Soft-nav and bfcache vitals need streaming. | `BTI#L147`, `#L622-L633`; `B/packages/browser/src/integrations/webVitals.ts#L20-L72` |
| `enableElementTiming` | deprecated, no effect (warns) | Use `elementTimingIntegration`. | `BTI#L153`, `#L305-L312` |
| `traceFetch` | `true` | `http.client` spans for fetch. | `BTI#L160`; `request.ts#L123` |
| `traceXHR` | `true` | Same for XHR. | `BTI#L167`; `request.ts#L124` |
| `enableHTTPTimings` | `true` | Resource-timing attributes on http spans. | `BTI#L174`; `request.ts#L125` |
| `ignoreResourceSpans` | `[]` | Drop resource spans by op (`resource.script`, `resource.css`, `resource.img`, `resource.other`...). | `BTI#L181` |
| `detectRedirects` | `true` | Fold fast redirects (threshold 1.5 s) into the previous span. | `BTI#L189`, `#L860` |
| `linkPreviousTrace` | `'in-memory'` | Span link to previous trace; `'session-storage'` writes to `sessionStorage`; `'off'`. | `BTI#L214` |
| `consistentTraceSampling` | `false` | Reuse the first trace's sampling decision. | `BTI#L231` |
| `enableReportPageLoaded` | `false` | Pageload ends only at `Sentry.reportPageLoaded()` or `finalTimeout`. | `BTI#L248` |
| `beforeStartSpan` | not set | Rewrite pageload/navigation start options. Name change sets source `custom`. | `BTI#L254`, `#L357-L376` |
| `shouldCreateSpanForRequest` | not set (= always true) | Per-URL span filter. | `BTI#L262`; `request.ts#L143-L144` |
| `onRequestSpanStart` / `onRequestSpanEnd` | not set | Hooks with request/response headers. | `BTI#L269`, `#L274` |
| removed in v11 | `trackFetchStreamPerformance`, `ignorePerformanceApiSpans`, `_experiments` (`enableInteractions`, `enableStandaloneClsSpans`, `enableStandaloneLcpSpans`) | Moved to separate integrations below. | `B10/packages/browser/src/tracing/browserTracingIntegration.ts`; MIG section 3 `@sentry/browser` |

Not configurable: the whole integration skips setup for bot user agents (`isBotUserAgent()`, `BTI#L350`, `#L428-L431`).

Split-out integrations (all v11, from `@sentry/browser-utils` or browser):

| Integration | Options and defaults | Source |
|---|---|---|
| `interactionsIntegration` | `idleTimeout 1000`, `finalTimeout 30000`, `childSpanTimeout 15000` (via `TRACING_DEFAULTS`). Creates `ui.action.click` / `ui.interaction.click` spans. | `B/packages/browser-utils/src/performance/interactions.ts#L41-L66`, `#L171` |
| `userTimingIntegration` | `ignore: []` (string\|RegExp, replaces `ignorePerformanceApiSpans`). Spans for `performance.mark/measure`. | `B/packages/browser-utils/src/performance/userTiming.ts#L13-L19`, `#L68` |
| `elementTimingIntegration` | none. Emits **metrics** `ui.element.render_time` and `ui.element.load_time` (distribution, ms). | `B/packages/browser-utils/src/performance/elementTiming.ts#L28-L95` |
| `webVitalsIntegration` | `ignore []`, `softNavigations true`, `bfcacheNavigations true`. Auto-added by browserTracing. | `B/packages/browser/src/integrations/webVitals.ts#L20-L72` |
| `fetchStreamPerformanceIntegration` | none. Adds `http.client.stream` sibling span for streamed bodies. | `B/packages/browser/src/integrations/fetchStreamPerformance.ts#L27-L40` |
| `bfcacheMetricsIntegration` | `maxReasons`: unset = Infinity, values < 1 clamped to 1. Emits metrics `browser.bfcache.navigation` (count), `browser.bfcache.not_restored` (count), `browser.bfcache.reload.duration` (distribution). | `B/packages/browser/src/integrations/bfcacheMetrics.ts#L28`, `#L85-L125`, `#L150-L160` |

### replayIntegration (`@sentry/replay`, folder `packages/replay-internal`)

Constructor defaults `B/packages/replay-internal/src/integration.ts#L111-L148`; types `B/packages/replay-internal/src/types/replay.ts`; constants `B/packages/replay-internal/src/constants.ts`. `RI` = integration.ts.

| Option | Default | Effect | Source |
|---|---|---|---|
| `replaysSessionSampleRate` / `replaysOnErrorSampleRate` | top-level init options, unset -> 0 | See browser-only table. | `RI#L424-L452` |
| `stickySession` | `true` | Replay session kept in `sessionStorage` across reloads. | `RI#L116` |
| `minReplayDuration` | `4999` ms, capped at 50 000 | Shorter session replays are not sent. | `RI#L114`, `#L200`; `constants.ts#L47-L53` |
| `maxReplayDuration` | `3 600 000` ms (60 min), capped at that | Replay stops after this. | `RI#L115`, `#L201`; `constants.ts#L56` |
| (fixed) idle | pause after 5 min, expire after 15 min | Not options. | `constants.ts#L15-L18` |
| `flushMinDelay` / `flushMaxDelay` | `5000` / `5500` ms | Segment upload debounce. | `RI#L112-L113`; `constants.ts#L21-L24` |
| `useCompression` | `true` | Deflate in a Web Worker. | `RI#L117` |
| `workerUrl` | not set (inline worker) | Self-hosted worker for strict CSP. | `RI#L118` |
| `maskAllText` | `true` | All text masked as `*`. | `RI#L120` |
| `maskAllInputs` | `true` | All input values masked; passwords always masked. | `RI#L121`, `#L162` |
| `blockAllMedia` | `true` | Blocks `img,image,svg,video,object,picture,embed,map,audio,link[rel=icon],link[rel=apple-touch-icon]`; ignores `background-image`. | `RI#L24-L25`, `#L122`, `#L225-L232` |
| `mask` / `unmask` | `[]` / `[]` | CSS selectors (plus built-in `.sentry-mask`, `[data-sentry-mask]`). | `RI#L136`, `#L138`; `B/packages/replay-internal/src/util/getPrivacyOptions.ts` |
| `block` / `unblock` | `[]` / `[]` | Selectors replaced by placeholder. | `RI#L139-L140` |
| `ignore` | `[]` | Input events ignored. | `RI#L141` |
| `maskAttributes` | `['title','placeholder','aria-label']` | Attributes masked when `maskAllText`. | `RI#L137` |
| `maskFn` | not set | Custom mask for text and inputs. | `RI#L142`, `#L163-L164` |
| `mutationBreadcrumbLimit` | `750` | Large-mutation breadcrumb threshold. | `RI#L124` |
| `mutationLimit` | `10000` | Stop replay above this many mutations in one batch. | `RI#L125` |
| `slowClickTimeout` | `7000` ms | Dead/slow click detection window (threshold 3000 ms fixed). | `RI#L127`; `constants.ts#L39` |
| `slowClickIgnoreSelectors` | `[]` | | `RI#L128` |
| `networkDetailAllowUrls` | `[]` | Only these URLs get headers/bodies captured. Empty -> no detail. | `RI#L130` |
| `networkDetailDenyUrls` | `[]` | | `RI#L131` |
| `networkCaptureBodies` | `true` (only for allow-listed URLs; max 150 000 chars) | | `RI#L132`; `constants.ts#L33` |
| `networkRequestHeaders` / `networkResponseHeaders` | `[]` + always `content-length`, `content-type`, `accept` | | `RI#L27`, `#L133-L134`, `#L215-L216` |
| `attachRawBodyFromRequest` | `false` | Patches global `Request` to keep original body. | `RI#L147`, `#L35-L66` |
| `beforeAddRecordingEvent` | not set | Filter/modify rrweb events. | `RI#L144` |
| `beforeErrorSampling` | not set | Return false to not trigger on-error replay. | `RI#L145` |
| `onError` | not set | Internal error callback. | `RI#L146` |
| `_experiments` | `{}`: `captureExceptions`, `traceInternals`, `continuousCheckout`, `recordCrossOriginIframes`, `ignoreMutations` | Unstable. | `RI#L119`, `#L194`; `replay.ts#L252-L268` |
| (fixed rrweb) | `slimDOMOptions:'all'`, `inlineStylesheet:true`, `inlineImages:false`, `collectFonts:true` | Not options. | `RI#L178-L184` |

Replay stamps `sentry.replay_id` on streamed spans and logs (`RI#L324-L333`; `B/packages/core/src/logs/internal.ts#L124-L137`).

### replayCanvasIntegration

| Option | Default | Source |
|---|---|---|
| `quality` | `'medium'` (low: 1 fps webp q0.25; medium: 2 fps q0.4; high: 4 fps q0.5) | `B/packages/replay-canvas/src/canvas.ts#L35-L64`, `#L72` |
| `maxCanvasSize` | `[1280, 1280]` | `canvas.ts#L66`, `#L70-L77` |
| `enableManualSnapshot` | not set (false) | `canvas.ts#L15`, `#L73` |

### feedbackIntegration (= `feedbackSyncIntegration`; `feedbackAsyncIntegration` lazy-loads UI)

Defaults `B/packages/feedback/src/core/integration.ts#L87-L141`; label constants `B/packages/feedback/src/constants/index.ts#L10-L31`. `FI` = integration.ts.

| Option | Default | Source |
|---|---|---|
| `id` | `'sentry-feedback'` | `FI#L89` |
| `autoInject` | `true` (floating button injected) | `FI#L90` |
| `showBranding` | `true` | `FI#L91` |
| `isEmailRequired` / `isNameRequired` | `false` / `false` | `FI#L92-L93` |
| `showEmail` / `showName` | `true` / `true` | `FI#L94-L95` |
| `enableScreenshot` | `true` | `FI#L96` |
| `useSentryUser` | `{email: 'email', name: 'username'}` (pre-fills from scope user) | `FI#L97-L100` |
| `tags` | not set | `FI#L101` |
| `styleNonce` / `scriptNonce` | not set | `FI#L102-L103` |
| `colorScheme` | `'system'` | `FI#L106` |
| `themeLight` / `themeDark` | `{}` | `FI#L107-L108` |
| `triggerLabel` | `'Report a Bug'` | `FI#L125`; constants `#L10` |
| `triggerAriaLabel` | `''` | `FI#L126` |
| `formTitle`, `submitButtonLabel`, `cancelButtonLabel`, `confirmButtonLabel` | `'Report a Bug'`, `'Send Bug Report'`, `'Cancel'`, `'Confirm'` | `FI#L111-L124`; constants `#L11-L14` |
| `nameLabel`, `namePlaceholder`, `emailLabel`, `emailPlaceholder`, `messageLabel`, `messagePlaceholder`, `isRequiredLabel`, `successMessageText` | `'Name'`, `'Your Name'`, `'Email'`, `'your.email@example.org'`, `'Description'`, (constant), `'(required)'`, `'Thank you for your report!'` | `FI#L111-L124`; constants `#L15-L22` |
| `addScreenshotButtonLabel`, `removeScreenshotButtonLabel`, `highlightToolText`, `hideToolText`, `removeHighlightText` | `'Add a screenshot'`, `'Remove screenshot'`, `'Highlight'`, `'Hide'`, `'Remove'` | `FI#L111-L130`; constants `#L23-L27` |
| `errorEmptyMessageText`, `errorNoClientText`, `errorTimeoutText`, `errorForbiddenText`, `errorGenericText` | constants | `FI#L130-L134`; constants `#L29-L31` |
| `onFormOpen`, `onFormClose`, `onSubmitSuccess`, `onSubmitError`, `onFormSubmitted` | not set | `FI#L137-L141` |

Methods: `attachTo(el, overrides)`, `createForm`, `createWidget`, `setTheme`, `remove` (`FI#L76-L85`).

### browserProfilingIntegration

| Option | Default | Source |
|---|---|---|
| `profileSessionSampleRate` (init) | 0 -> off | `B/packages/browser/src/profiling/utils.ts#L292-L306` |
| `profileLifecycle` (init) | `'manual'` | `B/packages/browser/src/profiling/integration.ts#L17-L24` |
| `profilesSampleRate` | **removed in v11** (v10: deprecated legacy per-transaction profiling) | `B10/packages/core/src/types/browseroptions.ts#L27`; MIG `Browser and Node profiling` |
| (fixed) max profile chunk | 30 000 ms | `utils.ts#L226` |

Requires the JS Self-Profiling API and the `Document-Policy: js-profiling` response header (header requirement: knowledge from the API, not re-verified here).

### Other opt-in integrations

| Integration | Options and defaults | Source |
|---|---|---|
| `httpClientIntegration` | `failedRequestStatusCodes [[500,599]]`, `failedRequestTargets [/.*/]`. Captures an error event per failed fetch/XHR, with headers and cookies per `dataCollection` (on by default in v11). | `B/packages/browser/src/integrations/httpclient.ts#L26-L48`, `#L78-L100` |
| `contextLinesIntegration` | `frameContextLines`: else `dataCollection.frameContextLines` (5), else 5. Inline-HTML frames only. | `B/packages/browser/src/integrations/contextlines.ts#L6`, `#L19-L27` |
| `reportingObserverIntegration` | `types ['crash','deprecation','intervention']` | `B/packages/browser/src/integrations/reportingobserver.ts#L55`, `#L71` |
| `extraErrorDataIntegration` | `depth 3`, `captureErrorCause true`; respects `maxValueLength` | `B/packages/core/src/integrations/extraerrordata.ts#L19-L38` |
| `captureConsoleIntegration` | `levels` = all console levels; `handled true`. Console calls become error/message events. | `B/packages/core/src/integrations/captureconsole.ts#L14-L29` |
| `rewriteFramesIntegration` | `root` unset; `prefix 'app:///'` (JSDoc says `'app://'`); `iteratee` custom | `B/packages/core/src/integrations/rewriteframes.ts#L32-L61` |
| `moduleMetadataIntegration` | none. Reads bundler-injected module metadata into frames. | `B/packages/core/src/integrations/moduleMetadata.ts#L15-L17` |
| `thirdPartyErrorFilterIntegration` | `filterKeys` (required), `behaviour` (required, 4 modes), `ignoreSentryInternalFrames false` | `B/packages/core/src/integrations/third-party-errors-filter.ts#L19-L53` |
| `zodErrorsIntegration` | `limit 10`, `saveZodIssuesAsAttachment false`; `key` declared but not read | `B/packages/core/src/integrations/zoderrors.ts#L8-L23`, `#L208` |
| `featureFlagsIntegration` (+ `launchDarklyIntegration`, `openFeatureIntegration`, `unleashIntegration`, `growthbookIntegration`, `statsigIntegration`) | No options on the generic one. Flag buffer 100 per scope; max 10 flags per span. | `B/packages/core/src/integrations/featureFlags/featureFlagsIntegration.ts#L39`; `B/packages/core/src/utils/featureFlags.ts#L18-L23`; `B/packages/browser/src/integrations/featureFlags/` |
| `graphqlClientIntegration` | `endpoints` (required). Adds operation name/type to http spans and breadcrumbs; document/variables per `dataCollection.graphQL`. | `B/packages/browser/src/integrations/graphqlClient.ts#L22-L24` |
| `spotlightBrowserIntegration` | `sidecarUrl 'http://localhost:8969/stream'` | `B/packages/browser/src/integrations/spotlight.ts#L14-L25` |
| `webWorkerIntegration` | `worker` (Worker \| Worker[]); `addWorker()`. Worker side calls `registerWebWorker({self})`. Forwards debug IDs, module metadata, and worker errors. | `B/packages/browser/src/integrations/webWorker.ts#L53-L58`, `#L133-L140` |
| `viewHierarchyIntegration` | `shouldAttach` (always), `rootElement` (`document.body`), `onElement` | `B/packages/browser/src/integrations/view-hierarchy.ts#L28-L56` |
| `supabaseIntegration` | client instance | exported from core (`B/packages/browser/src/index.ts`) |
| `consoleLoggingIntegration` | see Logs section | |

### @sentry/react

`init` adds React SDK metadata and `contexts.react.version`, and stringifies SyntheticEvents (`B/packages/react/src/sdk.ts`).

| API | Options and defaults | Source |
|---|---|---|
| `ErrorBoundary` / `withErrorBoundary` props | `fallback` (element or render fn), `showDialog` (false), `dialogOptions`, `handled` (unset -> `!!fallback`), `onError`, `onMount`, `onReset`, `onUnmount`, `beforeCapture(scope, error, componentStack)`. Component stack linked as `error.cause` (needs linkedErrors). | `B/packages/react/src/errorboundary.tsx#L24-L65`, `#L125-L127`; `B/packages/react/src/error.ts#L42-L60` |
| `reactErrorHandler(callback?)` | For React 19 `createRoot({onUncaughtError, onCaughtError, onRecoverableError})`. `handled` = callback present. Mechanism `auto.function.react.error_handler`. | `B/packages/react/src/error.ts#L82-L97` |
| `Profiler` / `withProfiler` / `useProfiler` | `name`, `disabled false`, `includeRender true`, `includeUpdates true`, `updateProps` | `B/packages/react/src/profiler.tsx#L20-L33`, `#L165-L168`, `#L181` |
| `createReduxEnhancer` | `attachReduxState true` (adds `redux_state.json` attachment to errors), `actionTransformer` identity (breadcrumbs), `stateTransformer` identity (into `contexts.state`), `configureScopeWithState` unset. State normalised to `normalizeDepth` or 3. | `B/packages/react/src/redux.ts#L57-L90`, `#L105-L145` |
| `reactRouterBrowserTracingIntegration` (new entry `@sentry/react/react-router` supplies hooks) | All browserTracing options plus `useLocation`, `useNavigationType`, `createRoutesFromChildren`, `matchRoutes` (optional via new entry), `useEffect` (deprecated, unused), `stripBasename false`, `enableAsyncRouteHandlers false`, `lazyRouteTimeout` = `idleTimeout*3` (3000), capped by `finalTimeout`, `lazyRouteManifest` string[]. Wraps browserTracing with its own pageload/navigation handling. | `B/packages/react/src/reactrouter-compat-utils/instrumentation.tsx#L171-L216`, `#L667-L700`; MIG `React: Simpler React Router setup` |
| `reactRouterV6BrowserTracingIntegration` / `reactRouterV7BrowserTracingIntegration` | Same options; deprecated aliases in v11. | `B/packages/react/src/reactrouterv6.tsx#L17-L22`; `B/packages/react/src/reactrouterv7.tsx#L18` |
| v3/v4/v5, TanStack Router integrations | exported | `B/packages/react/src/index.ts` |

## Logs and metrics APIs

### Do `enableLogs` / `enableMetrics` exist?

| Version | `enableLogs` | `enableMetrics` | Source |
|---|---|---|---|
| 10.78.0 | yes, default **`true`** (also `_experiments.enableLogs` fallback). `consoleLoggingIntegration` refused to run when false. | yes, default **`true`** (also `_experiments.enableMetrics`). | `B10/packages/core/src/types/options.ts#L586`, `#L607`; `B10/packages/core/src/client.ts#L264-L280`; `B10/packages/core/src/logs/console-integration.ts#L30-L33` |
| 11.11.0 | **removed**. No option; logs flow whenever `Sentry.logger.*` or a logging integration is used. Cannot be switched off except via `beforeSendLog` returning null. | **removed**. Same model. | `B/packages/core/src/types/options.ts` (absent); `B/packages/core/src/client.ts#L317-L326`; MIG `The enableLogs option was removed` and section 3 |

Step 4's claim is confirmed. Note that 10.78.0 already defaulted both to `true`, so the practical change is that v11 removed the off switch.

### `Sentry.logger.*`

| Item | Value | Source |
|---|---|---|
| Functions | `trace`, `debug`, `info`, `warn`, `error`, `fatal` `(message \| fmt\`...\`, attributes?, {scope?})` | `B/packages/core/src/logs/public-api.ts#L58-L240` |
| `logger.fmt` | Tagged template = `parameterize`; sends template plus parameters as `sentry.message.template` / `sentry.message.parameter.N`. | `public-api.ts#L246`; `B/packages/core/src/utils/parameterize.ts#L14-L31` |
| Auto attributes | `user.id`, `user.email`, `user.name` (from scope), `sentry.release`, `sentry.environment`, `sentry.sdk.name/version`, `sentry.replay_id` (+ `sentry._internal.replay_is_buffering`), trace context, scope attributes (`Sentry.setAttributes`). | `B/packages/core/src/logs/internal.ts#L100-L190` |
| Buffer count | flush at 100 logs | `internal.ts#L32`, `#L69-L71` |
| Buffer size | flush at estimated 800 000 bytes | `B/packages/core/src/client.ts#L159-L162` |
| Time | flush 5000 ms after the first buffered item (`_flushInterval`) | `client.ts#L69`, `#L163-L177` |
| Other triggers | `Sentry.flush()`, page hidden, `close()` | `client.ts#L180-L182`; `B/packages/browser/src/client.ts#L165-L186` |
| Wire item | `type: 'log'`, `content_type: application/vnd.sentry.items.log+json`, payload `{version: 2, ingest_settings: {infer_ip, infer_user_agent}, items}` | `B/packages/core/src/logs/envelope.ts#L9-L24` |

### `consoleLoggingIntegration` (`ConsoleLogs`)

`levels` default all console levels. `console.log` maps to `info` with severityNumber 10. Object-first calls become attributes; `%s` substitutions produce template attributes. Origin `auto.log.console`. Uses `normalizeDepth`/`normalizeMaxBreadth`. Source: `B/packages/core/src/logs/console-integration.ts#L13-L90`.

### `Sentry.metrics.*`

| Item | Value | Source |
|---|---|---|
| Functions | `count(name, value=1, {unit?, attributes?, scope?})`, `gauge(name, value, opts)`, `distribution(name, value, opts)`. No `set`/`timing` in v11. | `B/packages/core/src/metrics/public-api.ts#L9-L24`, `#L71`, `#L105`, `#L139` |
| Auto attributes | `user.id/email/name`, SDK, release, environment, replay id, scope attributes | `B/packages/core/src/metrics/internal.ts#L93-L165` |
| Buffer count | flush at 1000 metrics | `internal.ts#L29`, `#L66` |
| Size / time | same 800 KB / 5000 ms weight-based flushing as logs | `B/packages/core/src/client.ts#L320-L326` |
| Wire item | `type: 'trace_metric'`, `content_type: application/vnd.sentry.items.trace-metric+json`, `version: 2`, `ingest_settings` in browsers | `B/packages/core/src/metrics/envelope.ts#L13-L31` |
| CDN | Metrics only in `*.logs.metrics` CDN bundles; elsewhere `Sentry.metrics.*` is a no-op shim | MIG `Metrics moved out of the base CDN bundle` (code, MIG) |

## Manual instrumentation API

| API | One line | Source |
|---|---|---|
| `startSpan(opts, cb)` | Active span around `cb`, auto-ends. Browser variant also lazily installs span streaming. | `B/packages/core/src/tracing/browserSpanApi.ts#L48`; `B/packages/core/src/tracing/trace.ts#L54` |
| `startSpanManual(opts, cb)` | Active span, you call `span.end()`. | `browserSpanApi.ts#L58`; `trace.ts#L107` |
| `startInactiveSpan(opts)` | Span not set as active. | `browserSpanApi.ts#L68`; `trace.ts#L154` |
| `withActiveSpan(span, cb)` | Run `cb` with span active. | `trace.ts#L232` |
| `continueTrace({sentryTrace, baggage}, cb)` | Continue an incoming trace. | `trace.ts#L195` |
| `startNewTrace(cb)` | Fresh trace id for `cb`. | `trace.ts#L285` |
| `suppressTracing(cb)` | No spans created inside `cb`. | `trace.ts#L245` |
| `getTraceData({span?, scope?, client?, propagateTraceparent?})` | `{sentry-trace, baggage, traceparent?}` for manual propagation. | `B/packages/core/src/utils/traceData.ts#L35` |
| `span.setAttribute / setAttributes / setStatus / updateName / addLink(s) / end` | Span methods. | `B/packages/core/src/tracing/sentrySpan.ts#L136-L252` |
| `withScope(cb)` / `withIsolationScope(cb)` | Forked current / isolation scope. | `B/packages/core/src/currentScopes.ts#L66-L130` |
| `setTag(s)`, `setExtra(s)`, `setContext` | Isolation scope. Under streaming, tags and extra are **not** applied to spans, only to errors. | `B/packages/core/src/exports.ts#L62-L100`; MIG `Scope tags and extra are not applied to spans` |
| `setAttribute(s)` | Isolation-scope attributes applied to logs, metrics and streamed spans. | `exports.ts#L104-L146` |
| `setUser` | Isolation scope user; copied to logs/metrics as `user.*`. | `exports.ts#L153` |
| `setConversationId` | For gen_ai spans. | `exports.ts#L162` |
| `captureException/Message/Event` | Return event id. | `exports.ts#L27-L53` |
| `captureFeedback({message, name?, email?, url?, source?, associatedEventId?, tags?}, hint)` | Sends `type: 'feedback'` event. | `B/packages/core/src/feedback.ts#L8-L40` |
| `addBreadcrumb(crumb, hint?)` | Through `beforeBreadcrumb`, capped by `maxBreadcrumbs`. | `B/packages/core/src/breadcrumbs.ts#L20` |
| `lastEventId()` | Id of the last captured event. | `exports.ts#L177` |
| `flush(timeout?)` / `close(timeout?)` | Drain queue; `close` also unbinds the client. | `exports.ts#L189`, `#L207` |
| `startSession` / `endSession` / `captureSession` | Manual release-health sessions. | `exports.ts#L251-L290` |
| `reportPageLoaded()` | Ends pageload when `enableReportPageLoaded`. | `B/packages/browser/src/tracing/reportPageLoaded.ts` |
| `setRouteProvider` / `resolveRoute` | Runtime route naming. | `B/packages/browser-utils/src/routing.ts#L55` |
| `withStaticSpan(cb)` / `withStreamedSpan` / `spanToJSON` (now streamed format) / `spanToStaticSpanJSON` | Span format helpers. | `B/packages/browser/src/exports.ts`; MIG `Sentry.spanToJSON returns streamed span format` |
| Removed in v11 | `Scope.clear()`, `spanToStreamedSpanJSON`, `inboundFiltersIntegration` | MIG section 3 and 5 |

## Material differences 10.78.0 vs 11.11.0 (configuration)

Verified by diffing option names in `packages/core/src/types/options.ts`, `datacollection.ts`, browser `client.ts`, `sdk.ts`, `browserTracingIntegration.ts`, and reading `MIG`.

| Change | 10.78.0 | 11.11.0 | Source |
|---|---|---|---|
| `sendDefaultPii` | deprecated, default `false`; unset -> restrictive bridge (`userInfo:false`, cookies/headers deny PII snippets, no bodies, genAI off, DB off) | **removed**. `dataCollection` unset -> permissive defaults (`userInfo:true`, cookies, headers, bodies, genAI, DB, queues on) | `B10/packages/core/src/utils/data-collection/defaultPiiToCollectionOptions.ts`; `B/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts#L8-L21`; MIG `sendDefaultPii is replaced by dataCollection` |
| IP / UA inference in browser | `infer_ip: 'never'` unless opted in | `infer_ip: 'auto'` by default; logs/metrics/spans carry `ingest_settings` auto | `B/packages/browser/src/client.ts#L138-L147` (same code, different `userInfo` default) |
| `dataCollection.queryParams` | deprecated alias | removed (use `urlQueryParams`) | `B10/packages/core/src/types/datacollection.ts` diff |
| `dataCollection.mcp`, `.queues` | absent | added, default true | `B/packages/core/src/types/datacollection.ts#L101-L121` |
| `traceLifecycle` | default `'static'` | default `'stream'` | `B10/.../options.ts#L555`; `B/packages/core/src/client.ts#L267` |
| `beforeSendTransaction`, `ignoreTransactions` | active | deprecated, no-op unless `'static'` | `B/packages/core/src/types/options.ts#L354`, `#L620` |
| `beforeSendSpan` | receives `SpanJSON` | receives `StreamedSpanJSON`; static needs `withStaticSpan` | `options.ts#L599`; MIG |
| `attachStacktrace` | default `false` | default `true` | `B10/.../options.ts#L190`; `B/packages/core/src/client.ts#L265` |
| `enableLogs`, `_experiments.enableLogs` | exist, default `true` | removed | see Logs section |
| `enableMetrics`, `_experiments.enableMetrics` | exist, default `true` | removed | see Logs section |
| `_experiments.beforeSendMetric` | deprecated alias | removed; use top-level `beforeSendMetric` | MIG section 3 |
| `streamGenAiSpans` | default `true` | removed | `B10/.../options.ts#L579` |
| `disableInstrumentationWarnings`, `maxSpanWaitDuration` (server) | exist | removed | `B10/.../options.ts#L72`, `#L96`; MIG section 3 |
| `tunnel` | string | string \| `true` \| `{path, basePath, trailingSlash}` (managed tunnel) | `B/packages/core/src/types/options.ts#L655-L697` |
| `routeProvider` (browser) | absent | added | `B/packages/browser/src/client.ts#L90` |
| `profilesSampleRate` | deprecated | removed | `B10/packages/core/src/types/browseroptions.ts#L27`; MIG |
| `tracePropagationTargets` matching | case-sensitive; `g`/`y` flags stateful | case-insensitive; flags ignored | MIG |
| Default integrations | `inboundFiltersIntegration`; console crumbs inside `breadcrumbsIntegration` | `eventFiltersIntegration` (name `EventFilters`); new default `consoleIntegration`; `breadcrumbs.console` option removed | `B10/packages/browser/src/sdk.ts#L28-L50`; `B/packages/browser/src/sdk.ts#L30-L49` |
| `browserSessionIntegration.lifecycle` | default `'route'` | default `'page'` | `B10/packages/browser/src/integrations/browsersession.ts#L28`; `B/.../browsersession.ts#L26` |
| Unhandled-error session status | `crashed` | `unhandled` | `B/packages/browser/src/client.ts#L135-L136` |
| browserTracing options | `trackFetchStreamPerformance`, `ignorePerformanceApiSpans`, `_experiments.{enableInteractions, enableStandaloneClsSpans, enableStandaloneLcpSpans}` | removed; added `instrumentBfcacheRestore`, `webVitals`; new `interactionsIntegration`, `userTimingIntegration`, `fetchStreamPerformanceIntegration`, `elementTimingIntegration`, `bfcacheMetricsIntegration` | browserTracing diff; MIG section 3 |
| Web vitals | one set per page lifetime; CLS/LCP as pageload measurements in static | per soft navigation and per bfcache restore by default (streaming only); INP always a span with `browser.web_vital.inp.value` | MIG `Web vitals are reported per soft navigation`; `B/packages/browser/src/integrations/webVitals.ts#L72-L100` |
| Replay options | | no option changes (constructor identical) | diff of `B10`/`B` `packages/replay-internal/src/integration.ts` constructor |
| Metrics in CDN base bundle | included | moved to `*.logs.metrics` bundles | MIG |

## Findings that matter for a third party reading or coexisting with Sentry data

1. v11 with no `dataCollection` collects user info, cookies, headers and lets Relay infer IP and User-Agent (`infer_ip: 'auto'`) on events, sessions, logs, metrics and spans. v10 did the opposite by default.
2. Span streaming is the default. Spans leave as `span` v2 items in batches (5 s per trace, 1000 spans, 5 MB) rather than as transactions. `beforeSendTransaction`/`ignoreTransactions` silently do nothing; tags/extra no longer reach spans.
3. `maxValueLength` is unset, so error messages and URLs are not truncated client-side.
4. Logs and metrics have no off switch in v11. `elementTimingIntegration` and `bfcacheMetricsIntegration` emit Sentry metrics, not spans.
5. `browserTracingIntegration` skips bot user agents entirely, and under streaming the pageload span starts with the fixed name `"Pageload"` until a route provider names it.
6. JSDoc vs code mismatches: `enableLongAnimationFrame` (JSDoc false, code true), `rewriteFrames.prefix` (JSDoc `app://`, code `app:///`), `sampleRate` (JSDoc 1.0, code undefined = no sampling, same effect).
