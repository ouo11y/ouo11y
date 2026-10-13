# ADR-0008 Sentry SDK bridge: a Sentry receiver in ouo-collector, dual delivery, video replay kind

Status: proposed (2026-10-13)

## Context

The first buyer's iOS and Android apps already ship the Sentry SDKs. Replacing an SDK in a released mobile app is the most expensive step of any adoption: it needs an app release on both stores, a regression cycle and trust that the new SDK is as safe on device as the old one. Asking for it before ouo has proven anything kills the pilot.

The product plan sells a parallel-stack migration (roadmap Phase 12): run ouo next to the incumbent, compare, cut over only when the numbers agree. For mobile apps on Sentry that means ouo must consume what the Sentry SDKs already send, without changing the apps beyond their DSN, while Sentry keeps receiving exactly what it receives today.

What makes this feasible:

- The Sentry SDKs (`sentry-cocoa`, `sentry-java` / `sentry-android`, `sentry-react-native`) are MIT. Their wire format, the **envelope**, is documented on develop.sentry.dev. Relay and the Sentry server are source-available (FSL), so ouo implements the public protocol from the docs and the MIT SDK sources and copies no server code.
- ADR-0004 already follows Sentry's session health model (`ok`, `errored`, `crashed`, `abnormal`), so the mapping is mostly one to one.
- ADR-0007 made a custom collector distribution, `ouo-collector`, the only public ingress, with ouo components built in. A Sentry-speaking receiver is one more component of the same kind.
- ADR-0006 left room for a video replay behind the chunk `kind`. Sentry mobile replay sends H.264 mp4 segments with an rrweb-style recording of touches.

## Decision

1. **A `ouosentry` receiver in `ouo-collector`.** It listens on its own port (default `4320`) and serves `POST /api/{sentry_project_id}/envelope/`, the only endpoint current mobile SDKs use. The app changes nothing but the DSN host:

   ```
   before: https://<public_key>@o123.ingest.sentry.io/4504
   after:  https://<public_key>@sentry-bridge.example.com/4504
   ```

   Every other path is `404`. The legacy `store` endpoint, minidump and security report endpoints are out of scope.

2. **Sentry stays the system of record; ouo is a shadow.** For each request the receiver:
   1. authenticates the request against its project table (Sentry project id plus public key from `X-Sentry-Auth`, the `sentry_key` query parameter or the envelope `dsn` header); an unknown pair is `403` and is **not** forwarded, so the bridge is never an open proxy;
   2. forwards the request bytes unchanged (body, `Content-Encoding`, `Content-Type`, auth header and query, `User-Agent`) to the project's upstream Sentry ingest URL, synchronously;
   3. returns the upstream status, `X-Sentry-Rate-Limits`, `Retry-After` and body to the SDK verbatim, so SDK caching, retry and rate limiting behave exactly as without the bridge;
   4. only when upstream answered `2xx`, hands the envelope to the translator **asynchronously** through a bounded in-memory queue. A full queue drops the envelope on the ouo side and counts it; it never delays or fails the Sentry response.

   Translating only accepted envelopes means an SDK retry after an upstream failure is not double counted in ouo, and ouo sees what Sentry saw. Upstream unreachable is `502` to the SDK, which caches the envelope and retries, exactly as if Sentry were down.

   A project may set `upstream: none`. The receiver then answers `200 {"id":"<event_id>"}` itself and only translates. That is the cutover mode, and the mode for apps that never used Sentry.

3. **Translation produces ordinary ouo telemetry.** The translator emits OTLP log records and spans that satisfy `docs/specs/session-lifecycle.md`, with the ouo project from the project table placed in the request's client auth context, so the existing `resource/project` and `ouoratelimit` processors stamp and limit it exactly as for Basic-authenticated OTLP. Downstream nothing knows the data came from Sentry: Loki, Tempo, rum-api folding, ADR-0004 classification and the Grafana plugin work unchanged. The normative mapping is in `docs/specs/sentry-bridge.md`. In short:

   | Envelope item | ouo output |
   |---|---|
   | `session` | `session.start` on `init`, `session.end` on `exited`, `crashed`, `abnormal`; `session.id = sid` |
   | `event` with exception, or level `error` / `fatal` | `exception` log record; `ouo.exception.fatal` from level `fatal` or a `crashed` session update in the same envelope |
   | `transaction` | one OTel span per transaction and per child span, same trace and span ids; `http.request.failed` and `navigation` derived from `http.client` and `ui.load` spans |
   | `replay_video` | a `kind: "video"` replay chunk per segment, plus touches from the recording |
   | everything else (`attachment`, `profile`, `client_report`, `check_in`, `log`, `span`, `feedback`, `sessions`) | forwarded, not translated in this ADR |

4. **Session correlation is resolved in the receiver.** Sentry error, transaction and replay payloads do not carry the session id. The receiver resolves it in this order and records which rule matched in `ouo.sentry.session_match`:
   1. a `session` item in the same envelope (Sentry SDKs send the session update together with the error or crash that changed it);
   2. the replay id: from the envelope `trace.replay_id` header or `contexts.replay.replay_id`, through a learned `replay_id -> sid` map;
   3. the device: `did` from session updates equals the default `user.id` the mobile SDKs put on events (installation id when the app sets no user); the receiver keeps `(project, did) -> [sid, started, last_update]` and picks the session whose window covers the item's timestamp.

   Records that match no rule are still emitted, without `session.id`, so they are visible in Loki and Tempo but not folded into a session. State lives in a bounded LRU with a TTL of `SESSION_MAX_DURATION` (default 4 h). Replay segments that cannot be resolved yet are held up to 10 minutes, then dropped and counted.

   Which of these rules carry real traffic is the first implementation task: capture a day of envelopes from a debug build of each app and record the match rates in a kb entry before writing the translator.

5. **rum-api gains a `video` replay kind.** The replay pipeline from ADR-0007 is reused: the receiver emits chunk records into a dedicated pipeline and the existing `ouoreplay` exporter posts them to rum-api's internal `POST /v1/replay/chunks`. rum-api changes:
   - accept `kind: "video"` chunks (contract in `docs/specs/sentry-bridge.md`), validate the mp4 (`ftyp` box), limit by `MAX_VIDEO_CHUNK_BYTES` (default 8 MiB);
   - store the segment as `<seq>.mp4` next to `<seq>.json.gz` (metadata and touches without the video bytes), so it can be served with HTTP range requests;
   - `GET /v1/sessions/{id}/replay/video` returns a segment manifest with touches; `GET /v1/sessions/{id}/replay/video/{seq}` streams `video/mp4` with `Range` support; the events and frames endpoints return `409` for video replays and vice versa;
   - `meta.json`, the session list and detail report `replay_kind: "video"`.

   The Grafana plugin gets a third player: a `<video>` element that plays segments in order, maps the session timeline onto segment and offset for seeking, and draws the touch overlay and timeline markers like the frame player. One session still has one replay (ADR-0003); a second Sentry `replay_id` for the same session is dropped and counted.

   Transcoding mp4 into the JPEG `frames` kind was considered and rejected: it needs ffmpeg in the collector, multiplies storage and CPU, and loses quality for no product gain.

6. **The receiver does not hold more data than the SDK sent, and maps less.** Only allowlisted fields become attributes (spec section "Attribute allowlist"). `user.ip_address`, request cookies and headers, `extra` and arbitrary `contexts` are not copied. On-device masking stays the SDK's job, as with ouo's own SDKs (`maskAllText` and `maskAllImages` are on by default in Sentry mobile replay).

7. **Scope of this ADR: mobile only.** iOS (`sentry.cocoa`), Android (`sentry.java.android`) and React Native (`sentry.javascript.react-native`, which wraps both). Sentry's browser SDK sends one session per page load and rrweb replay segments; mapping it onto ouo's 30-minute session needs its own decision and is left out.

8. **No new dependencies for msgpack.** `replay_video` is a msgpack map with three binary values. The receiver decodes the small subset the SDKs write (fixmap or map16 or map32, str8/16/32 keys, bin8/16/32 values) with a hand-written decoder covered by fuzz tests.

## Consequences

- **Adoption cost drops to a DSN change** for apps on Sentry, on both platforms. Android sessions, health, traces and replay reach ouo before ouo's own Android SDK exists (roadmap Phase 10).
- **Sentry and ouo numbers will differ, by design, and the differences are documented** in the spec's "Expected differences" section: transaction sampling (`tracesSampleRate`) means fewer traces and fewer derived `http.request.failed` events; `abnormal` sessions (for example ANRs) are not `crashed` in ouo; sessions start and end on Sentry's rules, not ouo's. The Phase 12 comparison dashboard shows both sides.
- **Backend correlation needs one decision per backend.** Sentry SDKs propagate `sentry-trace` and Sentry `baggage` keys, not W3C `traceparent` and not `session.id`. Trace ids are identical, so Tempo still joins a backend span to the mobile trace when the backend continues it, but only if the backend's OTel SDK reads `sentry-trace` (a propagator), or the Sentry SDK is configured to also send `traceparent` where it supports it. Backend spans will not carry `session.id`; rum-api still finds the trace through the mobile spans that do.
- **The receiver is stateful.** Correlation rules 2 and 3 need the same replica to see a device's envelopes. Until a shared store exists (Phase 11), the Sentry receiver runs as its own single-replica deployment of `ouo-collector` (or with client-IP affinity), separate from the horizontally scaled OTLP ingress. Losing the state on restart costs correlation for in-flight sessions, not data.
- **Added latency on the Sentry path** is one extra hop inside the customer's network. The forward uses a pooled HTTP client with a 10 s timeout; the bridge publishes `ouo_sentry_upstream_duration_seconds`, `ouo_sentry_envelopes_total{outcome}`, `ouo_sentry_translate_dropped_total{reason}` and `ouo_sentry_session_match_total{rule}`.
- **Protocol drift is a maintenance cost.** Sentry evolves the envelope. Unknown item types and fields are forwarded and ignored by the translator; golden envelopes captured from pinned SDK versions are the test fixtures, and the supported SDK version range is listed in the spec.
- **Phase placement.** This is a migration-kit item (roadmap Phase 12) with a conditional trigger: when the warm buyer's mobile apps run Sentry, it moves ahead. Implementation touches `collector/` (receiver), `services/rum-api` (video kind) and `plugins/ouo-rum-app` (video player).
