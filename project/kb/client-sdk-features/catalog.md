# Client SDK feature catalog

Step 4 of the post-MVP plan. The unit is a **feature as an SDK user experiences it**, not an internal mechanism. Every row has a stable id; the [vendor files](vendors/index.md), the [target list](target-list.md) and the [matrix](feature-matrix.html) all use these ids.

- Platforms: web (browser), iOS, Android, React Native (RN).
- Vendors compared: Sentry, Datadog, PostHog, on all four platforms.
- Vendor files may add rows such as `ERR-x1` for features a vendor ships that this list does not name. Those extras are listed in the matrix under their group.
- Groups follow the founder's brief. Rows were written before the research, so a row can be "n/a" for a platform.

## SES sessions
- SES-a Automatic session tracking (start/end)
- SES-b Session timeouts (inactivity, background, max duration) and their defaults
- SES-c Session shared across tabs / subdomains (web); persistence across app restarts (mobile)
- SES-d Manual session control (start/stop/restart/get id)

## ERR errors and crashes
- ERR-a Unhandled exceptions (JS global / native uncaught)
- ERR-b Unhandled promise rejections (web, RN)
- ERR-c Handled/manual capture API (captureException etc.)
- ERR-d Native crash: signals/Mach (iOS), JVM uncaught + NDK (Android), native under RN
- ERR-e ANR (Android) / app hang (iOS) detection, thresholds
- ERR-f OOM / watchdog termination / app exit reasons
- ERR-g Breadcrumbs / event trail attached to errors (what is auto-collected, max count)
- ERR-h Client-side grouping control (fingerprint)
- ERR-i Attachments on error (screenshot, view hierarchy, files)
- ERR-j Console.error / log capture as errors
- ERR-k Error deduplication / rate limiting on client

## PERF performance and vitals
- PERF-a Core Web Vitals LCP/INP/CLS + FCP/TTFB
- PERF-b Vital attribution (INP target, LCP element)
- PERF-c Long tasks / long animation frames
- PERF-d Page load timing (navigation timing, document load span)
- PERF-e Resource timing (assets)
- PERF-f App start time (cold/warm/prewarm)
- PERF-g Slow/frozen frames, frame rate
- PERF-h Time to initial / full display (TTID/TTFD)
- PERF-i Profiling (JS self-profiling, mobile profiling)
- PERF-j Device vitals: CPU, memory, battery, thermal
- PERF-k Custom spans / transactions / timings API

## NET network
- NET-a Automatic fetch/XHR (web) / URLSession, OkHttp (mobile) capture
- NET-b Distributed trace propagation to backend (header format, allowlist, default)
- NET-c Request/response headers and bodies capture (opt-in?)
- NET-d GraphQL awareness
- NET-e Failed HTTP request as error (status ranges)
- NET-f WebSocket / other transports

## INT interactions
- INT-a Click/tap capture
- INT-b Action naming (how element names are inferred: text, aria, custom attr)
- INT-c Rage clicks / taps
- INT-d Dead clicks
- INT-e Error clicks
- INT-f Scroll, swipe, gesture capture
- INT-g Form / input / change autocapture
- INT-h Heatmaps (click/scroll maps)

## NAV navigation
- NAV-a Hard page loads as views
- NAV-b SPA route changes (History API, framework routers)
- NAV-c Mobile screen views (UIKit/SwiftUI, Activity/Fragment/Compose)
- NAV-d RN navigation (React Navigation, Expo Router)
- NAV-e Manual view API / custom view names
- NAV-f App foreground/background lifecycle events

## RPL replay
- RPL-a Web DOM replay (library used)
- RPL-b Mobile replay availability and capture method (wireframe vs screenshot/video)
- RPL-c Replay sampling modes (whole session vs on-error buffer), buffer length
- RPL-d Canvas / iframes / shadow DOM / WebGL
- RPL-e Network requests shown in replay (and bodies)
- RPL-f Console logs shown in replay
- RPL-g Replay masking defaults and mask/unmask APIs
- RPL-h RN replay support
- RPL-i SwiftUI / Jetpack Compose replay support
- RPL-j Replay limits (max duration, segment size, idle stop)

## USR user and attributes
- USR-a Set user id
- USR-b User traits / properties
- USR-c Global attributes / tags / context on every event
- USR-d Anonymous / device / install id handling
- USR-e Identify / alias merging (anon → known)

## LOG logs
- LOG-a Structured logs API from the client
- LOG-b Console capture as logs
- LOG-c OTel logs interop

## SMP sampling
- SMP-a Session sampling rate
- SMP-b Separate trace/performance sampling
- SMP-c Error sample rate
- SMP-d Buffer-on-error replay (record only when an error happens)
- SMP-e Errors kept when session unsampled
- SMP-f Remote config / remote sampling / kill switch

## PRV privacy
- PRV-a Consent API (pending/granted/denied), behaviour while pending
- PRV-b Text/input masking defaults (non-replay data)
- PRV-c Element/view-level mask/unmask API
- PRV-d URL / query sanitisation
- PRV-e PII defaults (sendDefaultPii, IP collection, geo)
- PRV-f beforeSend / event mapper hook
- PRV-g Opt-out / do-not-track respect

## TRN offline and transport
- TRN-a Batching / flush interval / batch size
- TRN-b Offline persistence and retry (storage, caps, TTL)
- TRN-c Page-unload delivery (sendBeacon/keepalive)
- TRN-d Compression
- TRN-e Custom endpoint / proxy / tunnel (ad-blocker bypass)
- TRN-f Server-driven rate limiting / backoff
- TRN-g Wire format (vendor envelope vs OTLP)

## CFG configuration
- CFG-a Init options style (single config object, DSN/token)
- CFG-b Per-integration enable/disable
- CFG-c Debug mode / SDK self-diagnostics / client reports of dropped data
- CFG-d Environment / release / dist / version options
- CFG-e Loader: npm, CDN, async snippet, lazy-load replay
- CFG-f SSR safety, web workers, browser extensions, micro-frontends

## API manual instrumentation
- API-a Custom events
- API-b Custom metrics / timings
- API-c Custom spans
- API-d Add context/attributes to current view / action
- API-e OTel interop (OTel API in, OTLP out, OTel propagation)

## SYM source maps and symbolication
- SYM-a JS source maps (upload, debug ids)
- SYM-b iOS dSYM
- SYM-c Android ProGuard/R8 mapping, NDK symbols
- SYM-d RN / Hermes source maps
- SYM-e Build tooling (CLI, Vite/Webpack plugins, Gradle, Xcode build phase, Expo plugin)

## FWK framework integrations
- FWK-a React (error boundary, router, profiler)
- FWK-b Next.js / SSR meta-frameworks
- FWK-c Vue, Angular, Svelte, others
- FWK-d SwiftUI / UIKit specifics
- FWK-e Jetpack Compose / OkHttp / other Android libs
- FWK-f React Native / Expo
- FWK-g Flutter, Unity, KMP, other platforms

## REL release and versioning
- REL-a Release / version tagging
- REL-b Release health: crash-free sessions/users
- REL-c Commits, suspect commits, deploys
- REL-d Version adoption

## FF feature flags
- FF-a Flag evaluations attached to errors / sessions
- FF-b Vendor's own flag service in SDK
- FF-c OpenFeature / third-party flag integrations

## FB user feedback
- FB-a Feedback widget (built-in UI)
- FB-b Feedback API (programmatic)
- FB-c Screenshot / shake-to-report

## OTH other
- OTH-a Product analytics autocapture (pageviews, events, funnels)
- OTH-b Experiments / A/B
- OTH-c Surveys
- OTH-d WebView / hybrid app tracking
- OTH-e Synthetic testing link to RUM
- OTH-f Third-party integrations (Segment, etc.)
- OTH-g Anything else the vendor ships on this platform
- OTH-h Bot and crawler filtering (added after the research; vendors' rows for it sit in their extras)
