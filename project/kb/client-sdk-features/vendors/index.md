# Vendor SDK research

One file per vendor and platform group. Every [catalog](../catalog.md) row is filled, defaults are read from source at the release tag where docs were vague, and cells not confirmed from a primary source say "uncertain". Rows such as `ERR-x1` are features the vendor ships that the catalog does not name. Docs pages showed no update date, so they are cited as accessed on 2026-11-10.

| File | SDKs and versions checked |
|---|---|
| [sentry-web.md](sentry-web.md) | `@sentry/browser` and framework packages 11.11.0 (2026-11-05) |
| [sentry-mobile.md](sentry-mobile.md) | sentry-cocoa 9.33.0, sentry-java 8.63.0, sentry-react-native 8.34.0 |
| [datadog-web.md](datadog-web.md) | `@datadog/browser-rum` and related packages 7.17.0 (2026-11-05) |
| [datadog-mobile.md](datadog-mobile.md) | dd-sdk-ios 3.21.0, dd-sdk-android 3.16.0, dd-sdk-reactnative 3.11.0 |
| [posthog-web.md](posthog-web.md) | `posthog-js` 1.447.6 (2026-11-09) |
| [posthog-mobile.md](posthog-mobile.md) | posthog-ios 3.94.3, posthog-android 3.76.1, posthog-react-native 4.85.4 |

These describe features as a user of each SDK experiences them. Step 6 goes deeper on each vendor's internals.
