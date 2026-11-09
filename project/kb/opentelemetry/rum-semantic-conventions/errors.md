# RUM conventions: errors and crashes

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## JS errors and unhandled rejections

**What OTel defines.** Event `exception`, **Stable** name, with Stable `exception.type`, `.message`, `.stacktrace`. Core v1.45.0 says exceptions SHOULD be recorded as attributes on a log record. The "SHOULD record exceptions as events", event-name and severity guidance is marked Development. Global handlers SHOULD use the plain name `exception`. Exception events emitted by an instrumentation that also records a span MUST be tied to that span's context.

The OTel browser instrumentation listens for `error` and `unhandledrejection`, both as `exception` with severity ERROR. Draft PR #551 adds `code.file.path`, `.line.number`, `.column.number` for uncaught errors only, since the browser gives no location for rejections.

**Event or span (Q10): event.** Not a span event: the span-event API is on its way to deprecation (OTEP 4430, see [logs entry](../data-models/logs.md)), and a global handler usually has no active span at all. A failed fetch still sets its span's status; that is separate.

**Attributes we need.**

| Attribute | Why | Status |
|---|---|---|
| `exception.type`, `.message`, `.stacktrace` | Core | Stable |
| `code.file.path`, `code.line.number`, `code.column.number` | Uncaught only | Draft #551 |
| `session.id`, `ouo.view.id`, `browser.document.url.full` | Join | See other entries |
| `ouo.exception.source` | `error`, `unhandledrejection`, `manual`. OTel cannot tell these apart today | None |
| `ouo.exception.handled` | Handled or not; drives session health | None |

**Q11, stack size.** Put the stack in `exception.stacktrace`, where the convention puts it, and cut it at source to 25 KiB, keeping the top. 25 KB is Swift's own default, and it stays well under Loki's 64 KB metadata limit for all attributes together. Anything richer goes in the body, following the SIG's "small attribute set, full object in the body" pattern from client-side #35.

**Q12, grouping.** The server computes a fingerprint after symbolication and stores `ouo.exception.fingerprint`. A client can supply the same attribute to override it. Computing in the SDK is wrong because minified or unsymbolicated frames change on every build.

**Prediction.** No event change. OTel does not plan a grouping attribute that we found. Confidence High for `exception`, Low for any fingerprint name.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Name | error event with exception values and a mechanism | `error` RUM event | `$exception` with `$exception_list` |

## Native crashes

**What OTel defines.** Event `app.crash`, Dev core. Recommended `exception.type`, `.message`, `.stacktrace`, `app.crash.id`, `session.id`. Conditionally required when the reporter is not the crashing instance: `app.build_id`, `os.name`, `os.version`, `service.version`. It explicitly allows reporting a crash from a later launch, and requires the crashing instance's values to be event attributes so they are not taken from the reporter's resource.

Android emits `app.crash` for both uncaught JVM and native (signal) crashes, with the original crash timestamp, read from context persisted per launch. **Swift's KSCrash emits `device.crash`**, the same concept under a name not in core. Its `exception.stacktrace` is an Apple-format report, unsymbolicated by default.

**Event or span: event.** The process is dead. It can only be replayed on next launch, so no span could be open or ended.

**Ours.** `app.crash` on every platform. On next launch, persist and send with the original time and the **crashed session's** `session.id`, which may differ from the current one. `app.build_id` is required for us, as symbolication depends on it. `exception.stacktrace` cut to 25 KiB. Severity FATAL.

The Client SIG notes show the wider problem is still open: delayed telemetry that belongs to a prior session or resource, and a possible attribute marking it as such. Confidence on `app.crash`: High.

React Native: JS fatal becomes `exception` with FATAL severity; a native crash under it is `app.crash` from the native side.

## ANR and hangs

See [performance entry](performance.md). They are treated as performance events, and they count towards session health.
