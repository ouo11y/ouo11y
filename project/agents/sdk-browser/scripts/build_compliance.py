#!/usr/bin/env python3
"""Builds project/kb/client-sdk-web/compliance/web-sdk-compliance.html from the spec's requirement
list (sdk-state findings), the Step 5 web audit, and the per-requirement record below.

  python3 -I project/agents/sdk-browser/scripts/build_compliance.py

M = method: U unit (vitest, jsdom), W wire (fake Collector), F fault injection, H real browsers
(Playwright: Chromium, Firefox, WebKit), S static check, L live stack (compose + demo app).
"""
import html
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..")
FIND = os.path.join(ROOT, "project", "agents", "sdk-state", "findings")
OUT = os.path.join(ROOT, "project", "kb", "client-sdk-web", "compliance", "web-sdk-compliance.html")
DATA = os.path.join(ROOT, "project", "agents", "sdk-browser", "findings", "web-compliance.json")

T = "sdk/browser/test/"
E = "sdk/browser/e2e/"
# id: (status, methods, where it is shown, note)
R = {
    "REL-2": ("met", "W,L", T + "wire.test.ts 'only OTLP to the configured endpoint'; live: Loki and Tempo", "Telemetry OTLP/HTTP JSON; replay OTLP/HTTP protobuf on /v1/logs"),
    "REL-3": ("met", "W", T + "wire.test.ts checkRecord (attribute name allow-list on every record)", ""),
    "REL-4": ("met", "U", T + "wire.test.ts 'the exposed providers ... OTel globals are untouched', 'a host that registered its own OpenTelemetry first keeps it'", "Providers are global only with otel.registerGlobalProviders. A context manager and propagator are registered when the host has none (the OTel instrumentations need them)"),
    "REL-5": ("met", "U", T + "wire.test.ts 'the exposed providers feed the same pipeline'", ""),
    "REL-6": ("met", "W", T + "wire.test.ts (no /v1/metrics request)", ""),
    "REL-7": ("met", "W", T + "wire.test.ts 'one client span per request ... no events'", "Span events an instrumentation adds are removed before export"),
    "API-1": ("met", "U,F", T + "safety.test.ts 'every function is a no-op that does not throw before init', '... survives any argument'; ssr.test.ts", ""),
    "API-2": ("met", "U", T + "safety.test.ts 'init does not wait for the network'", "Read: no public function awaits I/O; flush and shutdown are async. Not measured under a slow-storage stub"),
    "API-3": ("met", "W", T + "wire.test.ts 'rejects reserved names, counts them'", ""),
    "API-4": ("met", "S", "sdk/browser/src/index.ts exports", "The spec's function names"),
    "API-5": ("met", "W", T + "wire.test.ts 'trackNavigation names the navigation ... one signal', 'trackNavigation alone ...'", ""),
    "API-6": ("met", "W", T + "wire.test.ts 'recordException is manual and handled'", ""),
    "CFG-1": ("met", "U", T + "core.test.ts 'is off, without throwing', 'clamps out-of-range values'", ""),
    "CFG-2": ("met", "U", T + "core.test.ts 'clamps out-of-range values'", ""),
    "CFG-3": ("met", "U,W", T + "core.test.ts 'builds the Authorization header ... never mentions it'; safety.test.ts 'with debug on, no part of the credential'", ""),
    "CFG-4": ("met", "W,F", T + "wire.test.ts 'beforeSend runs on events and spans'; replay.test.ts (chunks never reach the hook)", ""),
    "LIF-1": ("met", "U", T + "safety.test.ts 'a second init is ignored with a diagnostic'", ""),
    "LIF-2": ("met", "U", T + "safety.test.ts 'init does not wait for the network'", ""),
    "LIF-3": ("met", "U", T + "wire.test.ts (records before the first flush are queued); queue bound in transport/queue.ts", "localStorage is synchronous; the outbox opens in the background and calls wait for it"),
    "LIF-4": ("met", "U,W", T + "wire.test.ts 'shutdown ends the session'; safety.test.ts 'listeners, patches and timers are gone'; replay.test.ts (ended record at shutdown)", ""),
    "LIF-5": ("met", "U", T + "wire.test.ts 'shutdown ends the session ... and init works again'; safety.test.ts 'init and shutdown fifty times'", ""),
    "LIF-6": ("met", "S", T + "version.test.ts 'no unload or beforeunload handler'", ""),
    "LIF-7": ("met", "U,H", T + "wire.test.ts 'at page hide everything queued leaves at once'; " + E + "sdk.spec.ts 'page close: ... abandoned span'; replay.spec.ts 'page close ends the stream'", ""),
    "LIF-8": ("met", "U", T + "wire.test.ts 'a page restored from the back/forward cache is a new view'", "Shown with a synthetic pageshow(persisted); a real bfcache restore was not driven in a browser"),
    "LIF-9": ("met", "U,S", T + "ssr.test.ts; sdk/browser/scripts/compat.mjs (imports dist in Node)", ""),
    "LIF-10": ("met", "U", T + "wire.test.ts 'a prerendered page starts no session'", "Shown by stubbing document.prerendering; a real prerender was not driven in a browser"),
    "SES-1": ("met", "U,W", T + "core.test.ts 'session ids are 32 lowercase hex'", "crypto.getRandomValues; without it the SDK stays off"),
    "SES-2": ("met", "W", T + "wire.test.ts checkRecord, 'restartSession links the sessions' (stamped at creation across a rollover)", ""),
    "SES-3": ("met", "U", T + "session.test.ts 'a visible init starts a session; a hidden one waits'", "A navigation counts as activity only in a visible page"),
    "SES-4": ("met", "W,H", T + "wire.test.ts 'session.start is the first record', 'restartSession ...'; " + E + "sdk.spec.ts 'two tabs ...'", ""),
    "SES-5": ("met", "U,W", T + "session.test.ts 'stamps do not extend the session'; wire.test.ts 'requests do not extend the session'", ""),
    "SES-6": ("met", "U", T + "session.test.ts 'writes last activity at most once per 5 s'", ""),
    "SES-7": ("met", "U,W", T + "session.test.ts 'activity after the timeout ends the old session at its last activity'", ""),
    "SES-9": ("met", "U", T + "session.test.ts 'reaching the maximum duration ... rolls at once'", ""),
    "SES-10": ("met", "U,W", T + "session.test.ts 'a polling tab makes none'; wire.test.ts 'without a valid session ...'", ""),
    "SES-11": ("met", "U,H", T + "session.test.ts 'two tabs share one session and emit one start'; " + E + "sdk.spec.ts 'two tabs share one session'", "Web Lock where available; write, re-read and adopt always"),
    "SES-12": ("met", "U,H", T + "session.test.ts 'blocked storage falls back to memory'; " + E + "faults.spec.ts 'storage blocked by the browser'", ""),
    "SIG-00": ("met", "W,H,L", "The SIG rows below; live: examples/ouo-web/scripts/verify.py", ""),
    "REC-1": ("met", "W", T + "wire.test.ts checkRecord", ""),
    "REC-2": ("met", "W", T + "wire.test.ts checkRecord, 'one browser.navigation ... each with a new view id'", ""),
    "REC-3": ("met", "W", T + "wire.test.ts checkRecord", ""),
    "REC-4": ("met", "W", T + "wire.test.ts checkRecord (observed >= time); session.end at last activity", ""),
    "REC-5": ("met", "W", T + "wire.test.ts checkRecord; replay.test.ts checkStream", "The bundled fetch/XHR instrumentations get the ouo.rum tracer"),
    "REC-6": ("met", "W,H", E + "sdk.spec.ts 'document load: one span after the fact'; wire.test.ts 'requests ... clicks do not parent them'", ""),
    "REC-7": ("met", "W", T + "wire.test.ts (INFO default, exception ERROR)", "ouo.sdk.disabled is WARN"),
    "REC-8": ("met", "U", T + "core.test.ts 'truncates strings at 4 KiB and stacks at 25 KiB'", ""),
    "REC-9": ("met", "S", "No clock offset code", ""),
    "SIG-01": ("met", "H,L", E + "sdk.spec.ts 'document load ... web vitals at page hide'; live verify 'every Web Vital this engine supports, once each'", ""),
    "SIG-02": ("met", "H", E + "sdk.spec.ts (INP attribution target and type in Chromium)", "Firefox and WebKit report no INP"),
    "SIG-30": ("met", "S", T + "version.test.ts (the name is absent from the source)", ""),
    "SIG-32": ("met", "H", E + "sdk.spec.ts 'document load ...' (vitals carry the page load's view id after a soft navigation)", ""),
    "SIG-08": ("met", "W,H", T + "wire.test.ts 'window errors and rejections ...', 'console.error and failed resource loads are not exceptions'", ""),
    "SIG-33": ("met", "W", T + "wire.test.ts 'an exception recorded inside an active span'", ""),
    "SIG-34": ("met", "W", T + "wire.test.ts (no fingerprint unless the app supplies one)", ""),
    "SIG-10": ("met", "W,H", T + "wire.test.ts 'a click is one event with position, tag, viewport and selector'", ""),
    "SIG-13": ("met", "W,L", T + "wire.test.ts rage, dead and error click tests; live verify", ""),
    "SIG-38": ("met", "W,L", T + "wire.test.ts 'requests ... clicks do not parent them'; live: 13 requests in 13 traces", ""),
    "SIG-39": ("met", "W,H", T + "wire.test.ts 'a click is one event ... no text'", ""),
    "SIG-14": ("met", "W,H", T + "wire.test.ts 'one browser.navigation per page load ...'", ""),
    "SIG-15": ("met", "H,L", E + "sdk.spec.ts 'document load: one span after the fact under the server's traceparent'", ""),
    "SIG-16": ("met", "H,L", E + "sdk.spec.ts (browser.navigation_timing)", ""),
    "SIG-17": ("met", "H", E + "sdk.spec.ts (browser.resource_timing with resources=1; timestamp is the resource start)", "Off by default"),
    "SIG-18": ("met", "W,H", T + "wire.test.ts 'one browser.navigation per page load and per History navigation ... hash changes are off'", ""),
    "SIG-21": ("met", "W,H,L", T + "wire.test.ts 'one client span per request'; " + E + "sdk.spec.ts", ""),
    "SIG-40": ("met", "W", T + "wire.test.ts (no span for the collector URL)", ""),
    "SIG-41": ("met", "W,L", "Same as SIG-38; documentLoad is the only span in the server's trace (" + E + "sdk.spec.ts)", ""),
    "SIG-22": ("met", "W", T + "wire.test.ts 'session.start is the first record ... with the sample rate'", ""),
    "SIG-23": ("met", "W", T + "wire.test.ts 'restartSession ...', 'shutdown ...'", ""),
    "SIG-24": ("met", "W", T + "wire.test.ts checkRecord", ""),
    "SIG-25": ("met", "W", T + "wire.test.ts checkRecord", ""),
    "SIG-26": ("met", "W,H,L", T + "replay.test.ts 'sends ouo.replay.chunk records as OTLP protobuf'; " + E + "replay.spec.ts", ""),
    "SIG-27": ("met", "W,H,L", T + "replay.test.ts (ended record); " + E + "replay.spec.ts", ""),
    "RES-0": ("met", "W", T + "wire.test.ts 'resource: service, SDK identity and environment only'", "user_agent.original is dropped when browser.brands exists"),
    "RES-1": ("met", "W", "Same test", ""),
    "RES-2": ("met", "W", T + "wire.test.ts checkRecord (forbidden resource attributes); no device id anywhere", ""),
    "RES-3": ("met", "W", T + "wire.test.ts checkRecord", ""),
    "RES-4": ("met", "S", "No entity API used", ""),
    "PRP-1": ("met", "W", T + "wire.test.ts 'traceparent goes to the same origin and to configured URLs only'", ""),
    "PRP-2": ("met", "W", "Same test", ""),
    "PRP-3": ("met", "W", T + "wire.test.ts 'an app-set traceparent and baggage are never overwritten', 'XHR: an app-set traceparent is kept'", ""),
    "PRP-4": ("met", "W", T + "wire.test.ts '... sampled flag clear (SMP-4)'", ""),
    "PRP-5": ("met", "H", E + "sdk.spec.ts 'document load ...'", ""),
    "PRP-6": ("met", "W,L", T + "wire.test.ts 'session baggage is sent only when configured'; live: backend spans carry session.id", ""),
    "TRN-1": ("met", "W", T + "wire.test.ts; replay.test.ts (application/x-protobuf)", "Telemetry stays JSON with gzip, as Step 5 recommended"),
    "TRN-2": ("met", "W", T + "wire.test.ts (gzip when large; uncompressed at page hide)", ""),
    "TRN-3": ("met", "F", T + "replay.test.ts 'a stalled replay endpoint does not delay telemetry'", ""),
    "TRN-4": ("met", "W", T + "wire.test.ts 'no request is sent when there is nothing to send, and batches respect maxBatchRecords'", ""),
    "TRN-5": ("met", "W", T + "replay.test.ts (one request per chunk)", ""),
    "TRN-6": ("met", "U,F", T + "core.test.ts status table; wire.test.ts 'retries 503 ..., drops 400 ..., honours partial success'", ""),
    "TRN-7": ("met", "U", T + "core.test.ts 'backoff is exponential with full jitter'", ""),
    "TRN-8": ("met", "U", T + "core.test.ts 'Retry-After is honoured and capped'", ""),
    "TRN-9": ("met", "F", T + "wire.test.ts 'a full queue evicts the oldest ordinary records first'", ""),
    "TRN-10": ("met", "F", T + "wire.test.ts (identical retry bytes); replay.test.ts 'retries reuse the bytes'", ""),
    "TRN-11": ("met", "F", T + "wire.test.ts 'a full queue ... keeps unhandled errors'", ""),
    "TRN-12": ("met", "F", T + "replay.test.ts 'persisted before its first send and removed only after a 2xx'", ""),
    "TRN-13": ("met", "U,F", T + "replay.test.ts 'the memory outbox honours the cap, the time to live'; drops counted", ""),
    "TRN-14": ("met", "U", T + "replay.test.ts 'evicts replay first, then telemetry, then bypass records'", ""),
    "TRN-20": ("met", "F,H", T + "replay.test.ts; " + E + "replay.spec.ts 'collector down: chunks wait in IndexedDB'", ""),
    "TRN-15": ("met", "F,H", E + "faults.spec.ts ('storage and the outbox throw', 'storage blocked by the browser')", "IndexedDB is asynchronous; a failure degrades to memory and is counted"),
    "TRN-16": ("met", "U,H", T + "wire.test.ts 'at page hide ... with keepalive, errors first' (total under 60 KiB); replay.test.ts 'page hide'", ""),
    "TRN-17": ("met", "S", "sendBeacon is not used", ""),
    "TRN-18": ("met", "F,H", T + "replay.test.ts 'a later page sends what a dead page left behind'; " + E + "replay.spec.ts", "Web Lock per stream"),
    "TRN-19": ("met", "F", T + "replay.test.ts 'page hide: ... stored with the end record'", ""),
    "SMP-1": ("met", "U", T + "session.test.ts 'the sampling decision is made once from the id and stored'", ""),
    "SMP-2": ("met", "U", T + "core.test.ts 'golden vectors'", ""),
    "SMP-3": ("met", "W", T + "wire.test.ts 'an unsampled session sends only unhandled errors'", ""),
    "SMP-4": ("met", "W", T + "wire.test.ts 'the request still carries traceparent with the sampled flag clear'", ""),
    "SMP-5": ("met", "W", "Same as SMP-3", ""),
    "SMP-6": ("met", "W", "Same as SMP-3 (ouo.sampling.bypass)", ""),
    "SMP-7": ("met", "W", "Same as SMP-3 (cap, counted)", ""),
    "SMP-8": ("met", "U", T + "core.test.ts 'golden vectors', 'the two decisions are independent'", ""),
    "SMP-9": ("met", "W", T + "replay.test.ts 'does not record: session not sampled'", "The option that picks session or buffer recording is the pair of rates, not the spec's replay.mode (ADR-0020)"),
    "SMP-10": ("met", "U", T + "replay.test.ts 'the buffer ring keeps whole segments'", ""),
    "SMP-11": ("met", "U", "Same test (nothing stored or sent before a trigger)", ""),
    "SMP-12": ("met", "W,H", T + "replay.test.ts 'buffer mode sends nothing until an unhandled error', 'replay.capture()'; " + E + "replay.spec.ts", ""),
    "PRV-1": ("met", "W,H", T + "wire.test.ts 'pending: nothing is sent or stored'; " + E + "sdk.spec.ts 'consent pending' (no IndexedDB database either)", ""),
    "PRV-2": ("met", "W", T + "wire.test.ts 'pending ...', 'denied while pending'", ""),
    "PRV-3": ("met", "W", T + "replay.test.ts 'replay consent missing', 'replay consent starts recording'", ""),
    "PRV-4": ("met", "W", T + "wire.test.ts 'withdrawal ends the session with reason consent'", ""),
    "PRV-5": ("met", "W,H", T + "replay.test.ts 'masks text as ***'; " + E + "replay.spec.ts (secrets searched in the output)", ""),
    "PRV-6": ("met", "W,H", "Same tests (data-ouo-unmask, data-ouo-mask wins, password / card / one-time-code never unmasked)", ""),
    "PRV-8": ("met", "F", T + "replay.test.ts 'a frame the adapter could not mask'; " + E + "faults.spec.ts ('replay cannot load or mask')", ""),
    "PRV-9": ("met", "U,H", T + "core.test.ts 'uses tags, nth-of-type and ids only'", ""),
    "PRV-10": ("met", "U,W", T + "core.test.ts URL vectors; wire.test.ts (url.full, document URL, code.file.path); replay.test.ts (page and link URLs)", ""),
    "PRV-11": ("met", "U", T + "core.test.ts 'keeps allowed query keys and ... a sanitised fragment'", ""),
    "PRV-12": ("met", "S", "No body or header capture exists", ""),
    "PRV-13": ("met", "W", T + "wire.test.ts 'enduser.id appears only after setUser'", ""),
    "PRV-14": ("met", "W", T + "wire.test.ts 'beforeSend ...' (exception message scrubbed)", ""),
    "RPL-1": ("met", "W", T + "replay.test.ts checkStream", ""),
    "RPL-2": ("met", "W", "Same (log record, bytes body)", ""),
    "RPL-3": ("met", "W", "Same (scope ouo.replay)", ""),
    "RPL-4": ("met", "W", T + "replay.test.ts 'a keyframe starts a new chunk and a new segment; sequence never resets'", ""),
    "RPL-5": ("met", "W,H", "One stream per page lifetime; new stream after stop/start and for the next page", ""),
    "RPL-6": ("met", "W", T + "replay.test.ts checkStream, keyframe test", ""),
    "RPL-7": ("met", "W", T + "replay.test.ts 'a chunk larger than the limit is split ... the concatenation is the payload'", "Both formats are streams of self-delimiting units"),
    "RPL-8": ("met", "F", T + "replay.test.ts 'a chunk refused with 400 ... a new keyframe first'", ""),
    "RPL-9": ("met", "U", "Keyframe timer and on visible (replay/engine.ts)", "SHOULD"),
    "RPL-10": ("met", "W,H", T + "replay.test.ts (time, size, stream end, page hide)", ""),
    "RPL-11": ("met", "W", T + "replay.test.ts split test (bodies under the limit)", ""),
    "RPL-12": ("met", "W,H", T + "replay.test.ts checkStream (hash recomputed); 'the synchronous SHA-256 agrees'", ""),
    "RPL-13": ("met", "W", T + "replay.test.ts checkStream (REQUIRED list)", ""),
    "RPL-14": ("met", "W", "Same (no ouo.replay.ref)", ""),
    "RPL-15": ("met", "F", T + "replay.test.ts 'persisted before its first send'", ""),
    "RPL-16": ("met", "W", "One sequential send queue per stream", ""),
    "RPL-17": ("met", "F", T + "replay.test.ts 'a backlog drops whole chunks of the oldest segment'", ""),
    "RPL-18": ("met", "F", "Same test (capture stops, reason max_size)", ""),
    "RPL-19": ("met", "W", T + "replay.test.ts 'does not record: ...'", ""),
    "RPL-26": ("met", "W", T + "replay.test.ts (ended attributes)", ""),
    "RPL-20": ("met", "F,H", T + "replay.test.ts 'a later page ... says the stream ended partial'; " + E + "replay.spec.ts", ""),
    "RPL-21": ("met", "F", T + "replay.test.ts (partial after a rejected chunk, a dropped frame, a backlog)", ""),
    "RPL-27": ("met", "U", "sdk/browser/src/replay/adapter.ts; the structure adapter and a stub pass the same engine", ""),
    "RPL-23": ("met", "U", T + "replay.test.ts 'engine contract with a stub format'", ""),
    "ERR-1": ("met", "F,H", T + "safety.test.ts (fault at every point); " + E + "faults.spec.ts (transcript equal with the SDK off and under every fault)", ""),
    "ERR-2": ("met", "U,H", T + "wire.test.ts 'the patched history methods behave like the originals'; safety.test.ts", ""),
    "ERR-3": ("met", "U", T + "safety.test.ts 'the app's own error handlers still run'", ""),
    "ERR-4": ("met", "S", T + "version.test.ts (no synchronous XHR)", "localStorage reads and writes are synchronous and small, as the spec's own SES-11 requires"),
    "ERR-5": ("met", "W", "Exports are not traced; drop events are not counted as drops", ""),
    "ERR-6": ("met", "F", T + "safety.test.ts 'after the threshold of internal errors ...'", ""),
    "ERR-7": ("met", "W", T + "wire.test.ts 'a flood of errors is rate limited and the drops are reported'; core.test.ts", ""),
    "ERR-8": ("met", "U", T + "safety.test.ts 'with debug on ...', 'with debug off the SDK prints nothing'", ""),
    "ERR-9": ("met", "S,F", "Every queue, ring, map and set has a bound (emitter, queue, engine, drops)", ""),
    "VER-2": ("met", "S", T + "version.test.ts (SPEC_VERSION, README, package.json ouo.specVersion)", ""),
    "VER-3": ("met", "W", T + "wire.test.ts checkRecord; replay.test.ts checkStream", ""),
}

reqs = json.load(open(os.path.join(FIND, "requirements.json")))
audit = {r["id"]: r for r in json.load(open(os.path.join(FIND, "audit-web.json")))["requirements"]}
rows = []
for r in reqs:
    before = audit.get(r["id"], {}).get("status", "na")
    if before == "na":
        continue
    status, methods, where, note = R.get(r["id"], ("unknown", "", "", "no record"))
    rows.append({"id": r["id"], "section": r["section"], "level": r["level"], "text": r["text"], "before": before, "now": status, "methods": methods, "where": where, "note": note})

must = [x for x in rows if x["level"] == "MUST"]
summary = {
    "must_total": len(must),
    "must_met_before": sum(1 for x in must if x["before"] == "met"),
    "must_met_now": sum(1 for x in must if x["now"] == "met"),
    "must_not_met_now": [x["id"] for x in must if x["now"] != "met"],
    "all_rows": len(rows),
}
os.makedirs(os.path.dirname(DATA), exist_ok=True)
json.dump({"summary": summary, "rows": rows}, open(DATA, "w"), indent=1)

e = html.escape
tr = "".join(
    f'<tr class="{x["now"]}" data-level="{e(x["level"])}"><td><b>{e(x["id"])}</b><br><small>{e(x["level"])}</small></td><td>{e(x["text"])}</td>'
    f'<td class="s {x["before"]}">{e(x["before"].replace("_", " "))}</td><td class="s {x["now"]}">{e(x["now"])}</td><td>{e(x["methods"])}</td><td>{e(x["where"])}'
    f'{("<br><i>" + e(x["note"]) + "</i>") if x["note"] else ""}</td></tr>'
    for x in rows
)
page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Web SDK compliance with the client SDK spec</title>
<style>
body{{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1b1b1b;max-width:1500px}}
h1{{font-size:22px}} .cards{{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}}
.card{{border:1px solid #d4d4d8;border-radius:8px;padding:12px 16px;min-width:160px}} .card b{{font-size:26px;display:block}}
table{{border-collapse:collapse;width:100%}} th,td{{border:1px solid #e4e4e7;padding:6px 8px;vertical-align:top;text-align:left}}
th{{background:#f4f4f5;position:sticky;top:0}} td small{{color:#71717a}} td i{{color:#52525b}}
.s{{white-space:nowrap;font-weight:600}} .s.met{{color:#15803d}} .s.partial{{color:#b45309}} .s.not_met,.s.unknown{{color:#b91c1c}}
.bar{{height:14px;background:#e4e4e7;border-radius:7px;overflow:hidden;max-width:520px}} .bar span{{display:block;height:100%;background:#15803d}}
input{{padding:6px 8px;width:320px;margin:8px 8px 8px 0}} label{{margin-right:12px}}
</style></head><body>
<h1>Web SDK compliance with the client SDK spec (0.1.0-draft)</h1>
<p><code>@ouo11y/browser</code> after the rebuild of 2026-11-12 (ADR-0020), against every requirement that applies to the web.
"Before" is the Step 5 audit of version 0.3.1. Methods: U unit, W wire against a fake Collector, F fault injection,
H real browsers (Chromium, Firefox, WebKit), S static check, L live stack with the demo app. Generated by
<code>project/agents/sdk-browser/scripts/build_compliance.py</code>.</p>
<div class="cards">
<div class="card">MUSTs that apply<b>{summary["must_total"]}</b></div>
<div class="card">Met before (0.3.1)<b>{summary["must_met_before"]}</b><div class="bar"><span style="width:{100 * summary["must_met_before"] / summary["must_total"]:.0f}%"></span></div></div>
<div class="card">Met now<b>{summary["must_met_now"]}</b><div class="bar"><span style="width:{100 * summary["must_met_now"] / summary["must_total"]:.0f}%"></span></div></div>
<div class="card">Not met now<b>{len(summary["must_not_met_now"])}</b>{e(", ".join(summary["must_not_met_now"]))}</div>
</div>
<p><b>What "met" rests on.</b> A test or check named in the last column, run on this commit. Three rows rest on a stand-in
for the real thing and say so in their note: the back/forward cache restore (LIF-8) and prerendering (LIF-10) were shown with
synthetic events in jsdom, not in a browser, and API-2 was not measured under a slow-storage stub. The spec's own conformance
suite (section 14) does not exist yet; this record is not a substitute for it.</p>
<input id="q" placeholder="Filter by id or text"><label><input type="checkbox" id="changed" style="width:auto"> only rows that changed</label>
<table><thead><tr><th>Id</th><th>Requirement</th><th>Before</th><th>Now</th><th>Method</th><th>Shown by</th></tr></thead><tbody id="rows">{tr}</tbody></table>
<script>
const q=document.getElementById('q'),c=document.getElementById('changed');
function f(){{const t=q.value.toLowerCase();for(const r of document.querySelectorAll('#rows tr')){{const b=r.children[2].textContent.trim(),n=r.children[3].textContent.trim();r.style.display=(r.textContent.toLowerCase().includes(t)&&(!c.checked||b!==n))?'':'none'}}}}
q.oninput=f;c.onchange=f;
</script></body></html>
"""
open(OUT, "w").write(page)
print(json.dumps(summary))
