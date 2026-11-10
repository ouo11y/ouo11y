# Incident catalog: SDKs that made their host app pay

Researched 2026-11-10. Each row has an id (`INC-n` for other vendors, `OUO-n` for our own faults) that the [checklist](../checklist/golden-rule-checklist.md) cites.

**How solid the sources are.** The URLs come from web search results; the pages were not all read in full, so the details are only as reliable as the search snippets. Rows marked *(mirror)* were seen only on a mirror site. For those the link given is the canonical github.com address with the same issue number, rebuilt by hand, so check it before quoting. Lychee runs offline in CI and does not fetch external links.

## Other vendors

| Id | Year | Vendor | What the host app suffered | Category | Platforms | Source |
|---|---|---|---|---|---|---|
| INC-1 | 2020-05 | Meta (Facebook iOS SDK) | A server-side config change sent a value of an unexpected type. Apps that only bundled the SDK (Spotify, TikTok, Tinder, Venmo) crashed at launch until Meta reverted it | crash, bad config, remote config | iOS | https://www.tweaktown.com/news/72378/facebooks-flub-broke-multiple-apps-this-week-on-the-iphone/index.html |
| INC-2 | 2020-07 | Meta (Facebook iOS SDK) | Again: Spotify, Pinterest, Waze crashed on start. Meta's post: a server-side code change triggered crashes in the SDK | crash, bad config | iOS | https://developers.facebook.com/blog/post/2020/07/13/bug-now-resolved-fb-ios-sdk-outage-causing-disruption-third-party-ios-apps/ |
| INC-3 | 2020 | Firebase status | Crashlytics status incident for the crash flood from that third-party SDK | crash | iOS | https://status.firebase.google.com/incident/Crashlytics/20004 |
| INC-4 | 2025 | Sentry JS | The fetch wrapper appended the hostname to network error messages; retry libraries (p-retry) no longer recognised them and stopped retrying | patching changes behaviour | web | https://github.com/getsentry/sentry-javascript/issues/18449 |
| INC-5 | 2025 | Sentry JS | The fetch wrapper defaulted the method to GET when the second argument was undefined | patching changes behaviour | web | https://github.com/getsentry/sentry-javascript/pull/18453 |
| INC-6 | 2018 | Sentry JS | A browser extension (LastPass) replaced `window.fetch` too; the two patches collided *(mirror)* | globals conflict | web | https://github.com/getsentry/sentry-javascript/issues/1601 |
| INC-7 | 2024 | Sentry JS | Next.js builds broke: an SDK dependency could not be resolved | upgrade, build | web | https://github.com/getsentry/sentry-javascript/issues/12586 |
| INC-8 | 2023 | Sentry Replay | Replay cost made pages slow; Sentry proposed auto-stopping replay when overhead is detected *(mirror)* | CPU, self-disable | web | https://github.com/getsentry/sentry-javascript/issues/8002 |
| INC-9 | 2024 | GitLab (Sentry customer) | Turned Sentry replay and sampling down on about.gitlab.com to save CPU | CPU | web | https://gitlab.com/gitlab-com/marketing/digital-experience/about-gitlab-com/-/merge_requests/3011 |
| INC-10 | 2025 | sentry-cocoa | Possible launch hang from `_dyld_get_image_header` on the main thread, fixed in 8.56.1 | main thread, startup | iOS | https://newreleases.io/project/github/getsentry/sentry-cocoa/release/8.56.1 |
| INC-11 | 2026 | sentry-cocoa | Deadlock in the crash handler caused by SDK debug logging; a background call blocked on a main-thread read | crash handler, main thread | iOS | https://newreleases.io/project/github/getsentry/sentry-cocoa/release/9.30.2 |
| INC-12 | 2024 | sentry-cocoa | Hang during init when a breadcrumb is added from another thread *(mirror)* | startup, main thread | iOS | https://github.com/getsentry/sentry-cocoa/issues/3492 |
| INC-13 | 2025 | sentry-java | ANRs: system broadcasts handled synchronously on the main thread | ANR | Android | https://github.com/getsentry/sentry-java/issues/4907 |
| INC-14 | 2025 | sentry-java | ANR from disk access in `getCacheDirPath` on the main thread *(mirror)* | ANR, storage | Android | https://github.com/getsentry/sentry-java/issues/4751 |
| INC-15 | 2025 | sentry-java | Random crashes after upgrading 8.17 to 8.23; rollback fixed them | crash, upgrade | Android | https://github.com/getsentry/sentry-java/issues/4890 |
| INC-16 | 2023 | sentry-java | Crash and ANR rate rose after an upgrade on Android 14 | crash, upgrade | Android | https://github.com/getsentry/sentry-java/issues/2955 |
| INC-17 | 2023 | Sentry status | Official incident: sentry-native raised crash and ANR rates in customer Android apps | crash, ANR | Android | https://status.sentry.io/incidents/912c0wsfxtgq |
| INC-18 | 2022 | sentry-react-native | Startup crash on poor networks, before the SDK finished init | crash, startup, offline | RN | https://github.com/getsentry/sentry-react-native/issues/2434 |
| INC-19 | 2020 | sentry-react-native | Release-only Android crashes after adding the SDK | crash | RN, Android | https://github.com/getsentry/sentry-react-native/issues/779 |
| INC-20 | 2021 | Sentry + Datadog + CodePush | Crash when the three SDKs ran together | handler conflict | RN | https://lightrun.com/answers/getsentry-sentry-react-native-crash-when-using-sentry-datadog--codepush-together |
| INC-21 | 2019 | Firebase Performance | Crash on password-autofill screens for 0.5% of users; removing the SDK fixed it | crash, swizzling | iOS | https://github.com/firebase/firebase-ios-sdk/issues/2283 |
| INC-22 | 2019 | Firebase Performance | 3.1.x crashed immediately on start *(mirror)* | crash, startup | iOS | https://github.com/firebase/firebase-ios-sdk/issues/3929 |
| INC-23 | 2025 | Crashlytics | EXC_GUARD crash on iOS 26 when registering Mach exception handlers *(mirror)* | crash, OS upgrade | iOS | https://github.com/firebase/firebase-ios-sdk/issues/15393 |
| INC-24 | n/a | New Relic iOS | Vendor documents its agent as incompatible with Firebase *(mirror)* | handler conflict | iOS | https://docs.newrelic.com/docs/mobile-monitoring/new-relic-mobile-ios/troubleshoot/firebase-incompatibility/ |
| INC-25 | 2023 | Crashlytics vs Intercom | Two signal handlers; init order decides which one wins and crash reports are lost | handler conflict | iOS | https://community.intercom.com/reporting-21/conflict-between-crashlytics-and-intercom-signal-handlers-in-ios-9328 |
| INC-26 | n/a | Apple DTS | iOS does not support more than one crash reporter per app | handler conflict | iOS | https://developer.apple.com/forums/thread/113742 |
| INC-27 | 2021 | New Relic browser agent | Its Promise wrapper broke jsPDF's native-Promise check; the agent crashed when a page redefined `self` | globals | web | https://docs.newrelic.com/kr/docs/release-notes/new-relic-browser-release-notes/browser-agent-release-notes/15/ |
| INC-28 | 2020 | Datadog iOS | Out-of-memory crash under heavy logging, fixed in 1.2.4 *(mirror)* | memory | iOS | https://github.com/DataDog/dd-sdk-ios/releases |
| INC-29 | 2021 | Datadog iOS | EXC_BAD_ACCESS in `CarrierInfoProvider` *(mirror)* | crash | iOS | https://github.com/DataDog/dd-sdk-ios/issues/623 |
| INC-30 | 2024 | Datadog Android | Vital monitor listeners never unregistered: memory leak *(mirror)* | memory | Android | https://github.com/DataDog/dd-sdk-android/issues/2008 |
| INC-31 | 2025 | PostHog JS | Session recording made pages sluggish; disabling recording fixed it | CPU | web | https://github.com/PostHog/posthog-js/issues/3273 |
| INC-32 | 2025 | rrweb | A preload link with a null sheet started endless timers and listeners: leak and CPU *(mirror)* | memory, CPU, battery | web | https://github.com/rrweb-io/rrweb/issues/1707 |
| INC-33 | 2023 | OpenTelemetry JS | `traceparent` on a third-party request triggered a CORS preflight the third party rejected; Cesium terrain failed to load | headers | web | https://community.cesium.com/t/failing-to-load-world-terrain-from-cesium-ion-because-of-traceparent-request-header-automatically-set-by-opentelemetry-web-auto-instrumentation/26699 |
| INC-34 | 2023 | Application Insights | Same class: correlation headers broke third-party calls | headers | web | https://lightrun.com/answers/microsoft-applicationinsights-js-appinsights-and-third-party-script-cors-problem |
| INC-35 | 2021 | OpenTelemetry JS | Fetch instrumentation sent requests without the app's own headers, only `traceparent` | patching changes behaviour | web | https://lightrun.com/answers/open-telemetry-opentelemetry-js-fetch-instrumentation-does-not-keep-original-request-headers |
| INC-36 | 2023 | OTel context-zone / Faro | Bundled zone.js conflicted with Angular's own copy | globals, upgrade | web | https://github.com/grafana/faro-web-sdk/issues/566 |
| INC-37 | 2016 | Atlassian analytics | Analytics filled localStorage; Jira showed uncaught `QuotaExceededError` | storage | web | https://support.atlassian.com/jira/kb/uncaught-quotaexceedederror-displays-in-browser-using-jira-server/ |
| INC-38 | 2015 | Ionic analytics | Analytics queue exceeded the storage quota | storage | web | https://forum.ionicframework.com/t/ionic-analytics-exceeded-the-quota/36609 |
| INC-39 | 2024 | Amplitude | SDK threw `SecurityError` on restricted localStorage in a cross-origin iframe | storage, crash | web | https://github.com/amplitude/Amplitude-TypeScript/issues/651 |
| INC-40 | 2024 | Application Insights | Its `unload` listener blocked the back/forward cache, so the team disabled it *(mirror of a dev.to post)* | unload | web | https://dev.to/eelcolos/disabling-applicationinsights-deprecated-unload-event-listener-in-angular-16kp |
| INC-41 | 2026-02 | Segment Analytics.js | Hours-long Analytics.js / Google Tag Manager incident | network, remote dependency | web | https://isdown.app/status/segment/incidents/530546-analytics-js-google-tag-manager-issue |
| INC-42 | 2018 | Google DoubleClick | Tag outage slowed ecommerce sites, async tags included | network | web | https://www.websitemagazine.com/ecommerce/implications-of-the-recent-google-ad-outage |
| INC-43 | 2022 | matrix-rust-sdk | Access tokens written to app logs through tracing (RUSTSEC-2022-0062) | privacy | multi | https://rustsec.org/advisories/RUSTSEC-2022-0062 |
| INC-44 | 2024 | WorkOS AuthKit | Debug flag logged refresh tokens (CVE-2024-51752) | privacy | web | https://www.wiz.io/vulnerability-database/cve/cve-2024-51752 |
| INC-45 | 2024 | Cognite SDK | Auth headers logged at DEBUG | privacy | multi | https://status.cognite.com/incidents/01HTHX47R5DX3A2985MS2EKXMF |

Not found in this sweep, so no checklist item cites one: a verified retry storm against an ingest endpoint, a Google Tag Manager container outage, a Bugsnag issue that crashed a host, and runtime crash issues in opentelemetry-android or opentelemetry-swift. Rules for those areas cite vendor guidance or our own faults instead.

## ouo's own faults

Lines checked on `origin/main` at 3e9e2c11.

| Id | Fault | Status | Evidence |
|---|---|---|---|
| OUO-1 | Android: an out-of-range `jpegQuality` throws in `Bitmap.compress` on the `ouo-replay-compose` daemon thread; the body is not wrapped, so the app dies | open | `sdk/android/replay/src/main/kotlin/dev/ouo/replay/OuoReplayConfig.kt:29-30` (no range check), `ScreenCapturer.kt:103`, `ReplayRecorder.kt:315-318`, thread at `ReplayRecorder.kt:348`; came in with de2b3bc4 |
| OUO-2 | RN replay debug log prints the first 8 characters of the project token | open | `sdk/react-native/src/replay.ts:300` |
| OUO-3 | RN fetch wrapper overwrites a `traceparent` the app set | open (XHR path is fixed) | `sdk/react-native/src/network.ts:43-47`, `155-160`; XHR skips it at `network.ts:283` |
| OUO-4 | Web: OTel `propagateTraceHeaderCorsUrls` injection overwrites an app-set `traceparent` | open | `sdk/browser/src/network.ts:46`, `64` |
| OUO-5 | RN replaces the Hermes promise rejection tracker without chaining; another SDK's tracker is dropped unless the app forwards with `onUnhandledRejection` | open, documented | `sdk/react-native/src/errors/install.ts:151-160` |
| OUO-6 | Web soak, WebKit only: +2 listeners and +2 observers every 5 minutes | fixed | `project/kb-archive/browser-sdk-safety.md:99` |
| OUO-7 | Web: a rejected `import("rrweb")` (CSP, ad blocker, offline) surfaced as an unhandled rejection on the host page | fixed in 775757ec | `project/kb-archive/browser-sdk-safety.md:17` |
| OUO-8 | Web: rrweb rethrows into the page unless `errorHandler` returns `true` | fixed | `project/kb-archive/browser-sdk-safety.md:14` |
| OUO-9 | Web: a 50k-element full snapshot (~5 MB) exceeds the chunker's 2 MB bound | known limit | `project/kb-archive/browser-sdk-safety.md:134` |
| OUO-10 | iOS: replay doubled main-thread time by resampling inside `drawHierarchy` | fixed in 9fb3dc4a | `sdk/ios/Sources/OuoReplay/ScreenCapturer.swift:82` |
| OUO-11 | Web: unguarded SDK callbacks and timers could throw into the page | fixed in 775757ec | `sdk/browser/src/guard.ts:33`, `43` |
| OUO-12 | Delivery lost telemetry: no retry, offline store or keepalive | fixed in e7c92c8a | `sdk/browser/src/transport/delivery.ts` |
| OUO-13 | No per-type error-flood guard | gap | `project/kb/client-sdk-features/gaps-for-step-7.md:29` (G5) |
