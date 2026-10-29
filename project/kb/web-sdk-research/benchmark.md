# Appendix M: measured here: six web SDKs on one page and one journey

What `@ouo11y/browser`, `@sentry/browser`, `@datadog/browser-rum`, `posthog-js`, Grafana Faro and
`@splunk/otel-web` cost in the page and on the wire, measured on 2026-10-29 on one Mac with headless
Chromium, every SDK talking to a local intake. Harness and exact commands:
[`project/agents/web-sdk-research/tools/web-bench/`](../../agents/web-sdk-research/tools/web-bench/README.md).
The method borrows the mobile benchmark's rules ([docs/benchmarks.md](../../../docs/benchmarks.md):
one app, one journey, a no-SDK baseline in every round, N ≥ 10 rounds interleaved and rotated,
medians with IQR, paired deltas against the baseline, losses reported as plainly as wins).

Every number is "measured here" unless it carries a code reference (`path:line`; ouo paths are
`sdk/browser/...` @ `a283b5b`, vendor paths are inside the npm package of the version below).
Engineering facts only.

## 1. Sources and versions

| Item | Value |
|---|---|
| ouo | `@ouo11y/browser` 0.3.0 built from this worktree (`a283b5b`) with its own `tsup` config, dependencies pinned to the repo `package-lock.json` (rrweb 2.1.7, `@opentelemetry/sdk-trace-web` 2.11.0, `*-0.222.0`, web-vitals 6.2.3) by `pin-ouo-deps.mjs`. A first build that resolved the `^` ranges fresh picked rrweb 2.2.0 and OTel 2.12.0 (+1.1 KB gzip); it was discarded. |
| Sentry | `@sentry/browser` 11.10.0 (`@sentry/replay` 11.10.0 carries Sentry's rrweb fork) |
| Datadog | `@datadog/browser-rum` 7.16.2 (`browser-rum-core`, `browser-core` 7.16.2) |
| PostHog | `posthog-js` 1.442.1 (npm module; recorder and surveys loaded lazily from `api_host`) |
| Faro | `@grafana/faro-web-sdk` 2.13.0, `@grafana/faro-web-tracing` 2.13.0 |
| Splunk | `@splunk/otel-web` 3.2.0, `@splunk/otel-web-session-recorder` 3.2.0 (installed cleanly with `--ignore-scripts`) |
| Bundler | esbuild 0.28.2: `--bundle --minify --format=esm --target=es2022`, code splitting on (lazy chunks stay lazy) |
| Browser | Playwright 1.64.1, Chromium 156.0.8078.4 headless shell (revision 1248, already installed; nothing downloaded) |
| Machine | Apple M5 (4 performance + 6 efficiency cores), 32 GB, macOS 27.0.1, Node 24.15.0. Shared with other sessions: 1-min load average 5.5 at the start, 15–25 during the runs (section 10). |

## 2. Setup

One static page (`page/index.html`, `page/app.js`: a list, a form, a fetch to the local backend, a
route change by `history.pushState`) served by `server.mjs`, which also plays every vendor's intake
on the same machine and records each request (wire bytes, decoded bytes, timing). Every SDK is
configured as its own docs recommend for RUM: traces/RUM on, errors on, 100 % sampling, replay on
(the `-norep` cells turn replay off). The journey is 60 s of scripted clicks, typing, list updates,
fetches and two route changes, then `pagehide`. Twelve cells (none + six SDKs × with/without replay),
10 rounds planned, order rotated each round. **Nine rounds (r0–r8) completed** and are reported: the
tenth was stopped to free the shared machine (section 10). A separate large-DOM run (10,000 extra
nodes, 5 rounds, six cells with replay) measures the first full snapshot.

KB is KiB (1,024 bytes). "Wire" is bytes on the wire after the SDK's own compression;
"decoded" is the payload after decompression.

## 3. Bundle (gzip -9, esbuild, code splitting)

| cell | eager (built) | lazy (built) | JS downloaded in the run | files downloaded |
| --- | --- | --- | --- | --- |
| none | 0.1 | 0.0 | 0.1 | sdk.js |
| ouo | 45.3 | 79.5 | 124.8 | sdk.js, rrweb-NB6EXSFY-QXMCHWBQ.js |
| sentry | 94.6 | 0.0 | 94.6 | sdk.js |
| datadog | 65.4 | 15.3 | 77.3 | sdk.js, chunk-NSKRKQ4B.js, chunk-OOWILHQ3.js, datadogRecorder-3TXCHR3X.js |
| posthog | 107.5 | 0.0 | 209.3 | sdk.js, /ph/array/config.js, /ph/static/surveys.js, /ph/static/lazy-recorder.js |
| splunk | 277.5 | 0.0 | 277.5 | sdk.js |
| faro | 90.1 | 0.0 | 90.1 | sdk.js |
| ouo-norep | 45.3 | 79.5 | 45.3 | sdk.js |
| sentry-norep | 54.3 | 0.0 | 54.3 | sdk.js |
| datadog-norep | 65.4 | 15.3 | 65.4 | sdk.js, chunk-NSKRKQ4B.js, chunk-OOWILHQ3.js |
| posthog-norep | 107.5 | 0.0 | 143.6 | sdk.js, /ph/array/config.js, /ph/static/surveys.js |
| splunk-norep | 146.8 | 0.0 | 146.8 | sdk.js |

- ouo's eager bundle is the smallest of the six (45.3 KB). Its size-limit gate measures 45,008 B
  with a different bundler and compression (`sdk/browser/package.json`), so the two numbers are not
  the same measure.
- With replay on, ouo downloads the most JavaScript after Splunk and PostHog: **124.8 KB**, because
  the lazy chunk is the whole `rrweb` package (79.5 KB, `sdk/browser/src/recorder.ts:109`
  `import("rrweb")`). Datadog's own recorder chunk is 15.3 KB and Sentry ships replay inside its
  94.6 KB. Importing `@rrweb/record` instead of `rrweb` (WB1) is the obvious cut; not measured here.

## 4. Page load

| cell | N | SDK init done | load event end | main-thread task (load+3 s) | Δ task | Δ script | long tasks | longest task | TBT | Δ TBT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 9 | 17.5 [15.8–19.9] | 21.1 [19.1–23.5] | 48 [47–49] | 0 | 0 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| ouo | 9 | 33.7 [26.7–38.9] | 37.2 [30.0–42.4] | 119 [109–141] | 70 | 40 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| sentry | 9 | 39.7 [27.1–48.1] | 57.9 [37.4–70.6] | 116 [95–122] | 67 | 70 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| datadog | 9 | 29.0 [16.5–34.0] | 32.0 [18.5–38.1] | 96 [69–105] | 47 | 15 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| posthog | 9 | 49.1 [39.6–60.6] | 118.7 [95.2–163.2] | 169 [115–188] | 121 | 93 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| splunk | 9 | 96.6 [62.0–117.1] | 108.7 [68.2–128.4] | 208 [145–231] | 161 | 120 | 1 [0–1] | 66 [0–69] | 16 [0–19] | 16 |
| faro | 9 | 47.1 [35.5–49.4] | 51.4 [39.1–52.4] | 79 [53–81] | 29 | 31 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| ouo-norep | 9 | 27.4 [17.2–31.9] | 30.5 [19.2–35.1] | 69 [45–82] | 22 | 20 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| sentry-norep | 9 | 31.1 [27.7–33.6] | 34.9 [31.1–37.3] | 77 [72–82] | 28 | 29 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| datadog-norep | 9 | 28.2 [25.9–31.4] | 33.1 [29.7–35.2] | 72 [69–79] | 24 | 9 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| posthog-norep | 9 | 50.6 [44.2–54.9] | 95.2 [79.8–99.2] | 97 [96–117] | 50 | 46 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |
| splunk-norep | 9 | 68.5 [61.8–77.3] | 72.6 [64.5–81.0] | 89 [81–103] | 40 | 41 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 0 |

Without replay ouo adds 22 ms of main-thread work at load (Datadog 24, Sentry 28, Faro 29,
Splunk 40, PostHog 50). With replay ouo adds 70 ms (Sentry 67, Datadog 47). No SDK except Splunk
made a long task at load.

## 5. Journey (60 s)

| cell | main-thread task ms | Δ task ms | Δ script ms | renderer CPU ms (all threads) | Δ renderer ms | long tasks | long-task sum ms | TBT ms | heap after GC MB | Δ heap MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 948 [829–986] | 0 | 0 | 1405 [1273–1472] | 0 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 2.1 [2.1–2.1] | 0.0 |
| ouo | 1379 [1328–1504] | 495 | 307 | 1978 [1898–2235] | 712 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 5.9 [5.9–5.9] | 3.8 |
| sentry | 1512 [1319–1652] | 569 | 434 | 2359 [2318–2585] | 1059 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 5.7 [5.7–5.7] | 3.7 |
| datadog | 1312 [1217–1351] | 334 | 293 | 2069 [2055–2284] | 696 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 4.1 [4.1–4.1] | 2.0 |
| posthog | 1724 [1643–1825] | 786 | 438 | 2612 [2341–2630] | 1154 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 6.3 [6.3–6.4] | 4.3 |
| splunk | 1908 [1843–2057] | 959 | 701 | 2862 [2756–2962] | 1387 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 6.8 [6.8–6.8] | 4.7 |
| faro | 1122 [1012–1189] | 202 | 65 | 1622 [1448–1711] | 253 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 3.9 [3.9–3.9] | 1.9 |
| ouo-norep | 1074 [996–1123] | 142 | 47 | 1548 [1466–1653] | 193 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 3.0 [3.0–3.0] | 0.9 |
| sentry-norep | 1049 [980–1156] | 175 | 80 | 1543 [1454–1673] | 227 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 3.4 [3.4–3.4] | 1.4 |
| datadog-norep | 1086 [989–1175] | 161 | 85 | 1578 [1464–1685] | 251 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 3.4 [3.4–3.4] | 1.3 |
| posthog-norep | 1113 [992–1257] | 192 | 89 | 1591 [1476–1782] | 267 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 3.8 [3.8–3.8] | 1.8 |
| splunk-norep | 1149 [1014–1211] | 205 | 101 | 1676 [1517–1733] | 282 | 0 [0–0] | 0 [0–0] | 0 [0–0] | 4.2 [4.2–4.2] | 2.1 |

- Without replay ouo is the cheapest SDK measured: +142 ms main-thread work per minute (Sentry 175,
  Datadog 161, Faro 202, PostHog 192, Splunk 205) and +0.9 MB heap.
- With replay ouo costs +495 ms per minute, more than Datadog (+334) and less than Sentry (+569),
  PostHog (+786) and Splunk (+959). Its heap grows +3.8 MB against Datadog's +2.0. The gap to
  Datadog is the recorder (rrweb vs Datadog's own serializer), not ouo's pipeline.
- No SDK made a long task during the journey on this machine.

## 6. Network per minute

| cell | telemetry req | telemetry wire | telemetry decoded | replay req | replay wire | replay decoded | preflights | page-hide wire | non-local requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 0 [0–0] | 0.0 [0.0–0.0] | 0 |
| ouo | 32 [32–32] | 33.9 [33.9–33.9] | 112.0 [112.0–112.1] | 10 [10–10] | 254.4 [254.3–254.5] | 2823.1 [2822.1–2823.7] | 3 [3–3] | 4.9 [4.9–4.9] | 0 |
| sentry | 32 [32–32] | 155.0 [154.8–156.2] | 155.0 [154.8–156.2] | 10 [10–10] | 277.3 [277.1–277.3] | 2901.7 [2900.4–2902.9] | 0 [0–0] | 3.7 [3.3–3.8] | 0 |
| datadog | 8 [8–8] | 109.2 [106.6–111.1] | 109.2 [106.6–111.1] | 19 [19–19] | 173.3 [173.1–173.4] | 794.6 [793.8–794.8] | 0 [0–0] | 10.8 [5.7–11.1] | 0 |
| posthog | 17 [17–17] | 24.9 [24.9–25.1] | 135.2 [135.1–135.2] | 15 [15–15] | 325.4 [325.3–325.6] | 643.5 [643.1–643.7] | 0 [0–0] | 11.8 [11.2–15.8] | 0 |
| splunk | 12 [12–13] | 417.0 [415.8–417.0] | 417.0 [415.8–417.0] | 9 [9–9] | 207.2 [207.1–207.2] | 1792.7 [1792.4–1793.8] | 3 [3–3] | 14.8 [14.8–22.1] | 0 |
| faro | 41 [41–41] | 93.1 [93.0–93.2] | 93.1 [93.0–93.2] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 1 [1–1] | 1.6 [1.5–1.7] | 0 |
| ouo-norep | 32 [32–32] | 34.1 [34.1–34.1] | 112.6 [112.5–112.6] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 2 [2–2] | 4.9 [4.9–4.9] | 0 |
| sentry-norep | 32 [32–32] | 148.3 [148.2–151.1] | 148.3 [148.2–151.1] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 0 [0–0] | 3.5 [3.5–3.5] | 0 |
| datadog-norep | 8 [8–8] | 105.0 [104.6–107.7] | 105.0 [104.6–107.7] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 0 [0–0] | 3.2 [3.2–7.2] | 0 |
| posthog-norep | 17 [17–17] | 22.8 [22.8–22.8] | 117.9 [117.9–117.9] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 0 [0–0] | 1.1 [1.1–1.1] | 0 |
| splunk-norep | 13 [12–13] | 333.8 [333.7–334.4] | 333.8 [333.7–334.4] | 0 [0–0] | 0.0 [0.0–0.0] | 0.0 [0.0–0.0] | 2 [2–2] | 16.5 [11.1–19.5] | 0 |

- ouo sends the least telemetry on the wire of the SDKs that compress (33.9 KB/min, gzip of
  OTLP/JSON; PostHog 24.9 KB/min sends fewer, smaller events). Sentry sends 155 KB/min
  uncompressed, Datadog 109, Splunk 417.
- ouo's replay is 254 KB/min on the wire (Datadog 173, Sentry 277, PostHog 325). Decoded it is
  2.8 MB/min against Datadog's 0.79 MB: Datadog's record format is about 3.5× smaller before
  compression. Wire is what users pay; decoded is what the intake and storage pay.
- ouo makes 32 telemetry requests per minute plus 3 CORS preflights (OTLP/JSON with
  `Content-Type: application/json` to another origin). Datadog batches into 8. Fewer, larger
  batches (WB5) and a preflight-free content type are worth testing.

## 7. Large DOM (first full snapshot)

| cell | N | DOM nodes | longest task | Δ longest | TBT | main-thread task | Δ task | first replay request at (ms from nav) | first replay wire KB | first replay decoded KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 5 | 13456 [13456–13456] | 0 [0–0] | 0 | 0 [0–0] | 71 [66–81] | 0 | – [–––] | – [–––] | – [–––] |
| ouo | 5 | 13456 [13456–13456] | 0 [0–0] | 0 | 0 [0–0] | 123 [121–131] | 58 | 97 [96–99] | 61.0 [61.0–61.0] | 864.6 [864.6–864.6] |
| sentry | 5 | 13456 [13456–13456] | 54 [53–55] | 54 | 4 [3–5] | 151 [149–164] | 83 | 5529 [5528–5536] | 114.4 [114.4–114.4] | 1629.8 [1629.8–1629.8] |
| datadog | 5 | 13456 [13456–13456] | 0 [0–0] | 0 | 0 [0–0] | 111 [101–115] | 37 | 3652 [3643–3653] | 34.2 [34.2–34.2] | 238.6 [238.6–238.6] |
| posthog | 5 | 13459 [13459–13459] | 0 [0–0] | 0 | 0 [0–0] | 153 [152–154] | 84 | 6680 [6676–6681] | 73.2 [73.2–73.4] | 180.0 [180.0–180.6] |
| splunk | 5 | 13456 [13456–13456] | 60 [58–61] | 60 | 10 [8–11] | 258 [249–258] | 177 | 220 [206–223] | 55.1 [55.1–55.1] | 709.4 [709.4–709.4] |


ouo sends the first replay request soonest (97 ms after navigation) and makes no long task;
Sentry (54 ms) and Splunk (60 ms) do. ouo's first snapshot is 61 KB on the wire and 865 KB decoded,
against Datadog's 34 KB / 239 KB.

## 8. What it means for ouo

1. Core SDK: smallest eager bundle, cheapest journey, least compressed telemetry: at or ahead of
   every vendor measured.
2. Replay is where ouo is behind Datadog: +79.5 KB lazy JS, +161 ms/min CPU more, +1.8 MB heap
   more, +81 KB/min wire more, 3.5× more decoded bytes. WB1 (`@rrweb/record`, upstream rrweb)
   and WB5 (replay production-grade: batching, stylesheet dedupe, worker compression) target
   exactly this, and WB10 puts these cells in CI so the change is measured.
3. 32 requests and 3 preflights per minute: batch harder.

## 9. Limits

- One machine, one Chromium, headless, no CPU or network throttling: absolute numbers are for
  this Mac; the paired deltas and the ranking are what carries over.
- Nine rounds, not ten. IQRs are in every table; where two cells' IQRs overlap (ouo vs Sentry at
  load, the `-norep` cells in the journey) the order between them is not established.
- Default or documented RUM configuration per vendor; each vendor can be tuned further.
- Replay fidelity (what the replay looks like) is not measured, only cost.
- PostHog loads its recorder and surveys from `api_host` (served locally here).

## 10. Machine load

The Mac was shared with other sessions and the CI runner: 1-minute load average 5.5 at the start,
15–25 during most rounds and 85 when the run was stopped (23:37). Rounds are interleaved and
rotated so load hits every cell alike, which is why the deltas are paired per round.

## 11. Reproduce

See the harness [README](../../agents/web-sdk-research/tools/web-bench/README.md):
`node run.mjs --rounds 10 --journey 60 --out results/main.json`, then
`node report.mjs results/main.json results/large-dom.json` prints these tables.

