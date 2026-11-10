# What vendors and platforms say about SDK safety

Collected 2026-11-10 from search results. The checklist cites these as `GUIDE-n` where no incident exists.

| Id | Source | What it says | URL |
|---|---|---|---|
| GUIDE-1 | OpenTelemetry specification, Error handling | Implementations MUST NOT throw unhandled exceptions at runtime; prefer safe defaults; let users plug in an error handler | https://opentelemetry.io/docs/specs/otel/error-handling/ |
| GUIDE-2 | Sentry SDK development philosophy | On an unsupported platform, degrade to doing nothing; no dependency is required for base function | https://develop.sentry.dev/sdk/philosophy/ |
| GUIDE-3 | PostHog SDK guidelines | The SDK should never be why an app crashes, slows down or fails to build | https://posthog.com/handbook/engineering/sdks/guidelines |
| GUIDE-4 | Sentry native, signal handling | How to chain handlers registered before and after init | https://docs.sentry.io/platforms/native/advanced-usage/signal-handling/ |
| GUIDE-5 | Sentry Apple, app hangs | A watchdog thread detects hangs without touching the main thread | https://docs.sentry.io/platforms/apple/configuration/app-hangs/ |
| GUIDE-6 | Sentry Apple, shared environments | Do not use Sentry inside another SDK: it leaks data across owners | https://docs.sentry.io/platforms/apple/configuration/shared-environments/ |
| GUIDE-7 | Datadog, SDK performance impact (Android) | Publishes continuous benchmarks of CPU, memory and network | https://docs.datadoghq.com/real_user_monitoring/application_monitoring/android/sdk_performance_impact/ |
| GUIDE-8 | Datadog, browser setup | CDN sync loading can delay page load; async can miss early events | https://docs.datadoghq.com/real_user_monitoring/browser/setup/client |
| GUIDE-9 | PostHog, recording performance | Measured cost of session recording | https://posthog.com/blog/session-recording-performance |
| GUIDE-10 | Embrace, more than one crash reporter | Running several crash reporters makes the result depend on order | https://support.embrace.io/support/solutions/articles/66000491994-can-our-app-user-more-than-one-crash-reporter- |
| GUIDE-11 | Android, ANRs | Do no disk or network I/O on the main thread; a 5 s input timeout is an ANR | https://developer.android.com/topic/performance/vitals/anr |
| GUIDE-12 | Apple, improving app responsiveness | Hangs above 250 ms are user-visible; keep the main thread free | https://developer.apple.com/documentation/xcode/improving-app-responsiveness |
| GUIDE-13 | web.dev, third-party JavaScript | Load third parties async, defer them, measure their main-thread cost | https://web.dev/articles/efficiently-load-third-party-javascript |
| GUIDE-14 | Chrome, unload deprecation | Do not use `unload`; use `pagehide` or `visibilitychange` with `sendBeacon` or `keepalive` | https://developer.chrome.com/docs/web-platform/deprecating-unload |
