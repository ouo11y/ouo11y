#!/usr/bin/env python3
"""Trace-continuity checks shared by every example's `verify` (checklist N24).

For the requests a journey sent to the demo backend between --start and --end, in Tempo:

  1. no orphan parents: every backend server span's parent span id exists in the same trace
     (Sentry sends a random parent span id when no transaction is active);
  2. one trace from client to backend: that parent is a client span of the app (--client);
  3. ouo paths (--path ouo): backend spans carry the session.id the client sent in baggage;
  4. no dropped traces: every client request to the backend (client span whose URL starts with
     --backend-url) has a backend server span in its trace (an unsampled `traceparent` makes the
     backend's ParentBased sampler drop it), and the counts match --expect-requests /
     --expect-traces when given; with --loki, every request in the backend's own request log
     (written whether or not the trace is sampled) is a sampled trace in Tempo, and the number of
     backend spans equals the number of logged requests;
  5. CORS: a browser preflight to the backend allows traceparent, tracestate, baggage, plus
     sentry-trace on the Sentry path;
  6. never the ouo SDK and the Sentry bridge into ouo at once: on the Sentry path every client
     span came through the bridge and no span in the window has `ouo.rum.mode` parallel or ouo;
     on the ouo path no client span came through the bridge.

Python 3 standard library only. Used as a module by the examples' verify scripts, or alone:

  tracecheck.py --tempo http://localhost:3200 --backend-url http://localhost:8081 \
      --client web-store --path ouo --start 1792000000 --end 1792000300 [--expect-requests 12]

Exit status 0 when every check passed.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

BACKEND_SERVICE = "demo-backend"
W3C_HEADERS = ["traceparent", "tracestate", "baggage"]


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_id: str
    name: str
    kind: str
    service: str
    attrs: dict
    resource: dict
    start: float = 0.0  # unix seconds


@dataclass
class Result:
    checks: list = field(default_factory=list)  # (name, ok, detail)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail else ""), flush=True)

    @property
    def ok(self) -> bool:
        return all(ok for _, ok, _ in self.checks)


def _hex(v: str) -> str:
    """Tempo's OTLP JSON has base64 ids (v2 API) or hex; normalise to lowercase hex."""
    if not v:
        return ""
    if all(c in "0123456789abcdefABCDEF" for c in v) and len(v) in (16, 32):
        return v.lower()
    try:
        return base64.b64decode(v + "=" * (-len(v) % 4)).hex()
    except ValueError:
        return v


def _value(v: dict):
    for k in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if k in v:
            return v[k]
    return None


def _attrs(lst) -> dict:
    return {a["key"]: _value(a.get("value", {})) for a in lst or []}


_KINDS = {"SPAN_KIND_SERVER": "server", "SPAN_KIND_CLIENT": "client", 2: "server", 3: "client", "2": "server", "3": "client"}


def parse_trace(doc: dict) -> list[Span]:
    """Spans of one Tempo trace (`/api/v2/traces/<id>` or `/api/traces/<id>` JSON)."""
    batches = doc.get("trace", doc).get("resourceSpans") or doc.get("batches") or []
    out = []
    for b in batches:
        res = _attrs(b.get("resource", {}).get("attributes"))
        for ss in b.get("scopeSpans") or b.get("instrumentationLibrarySpans") or []:
            for s in ss.get("spans", []):
                out.append(Span(
                    trace_id=_hex(s.get("traceId", "")), span_id=_hex(s.get("spanId", "")),
                    parent_id=_hex(s.get("parentSpanId", "")), name=s.get("name", ""),
                    kind=_KINDS.get(s.get("kind"), "internal"), service=str(res.get("service.name", "")),
                    attrs=_attrs(s.get("attributes")), resource=res,
                    start=int(s.get("startTimeUnixNano", 0) or 0) / 1e9))
    return out


def span_url(s: Span) -> str:
    return str(s.attrs.get("url.full") or s.attrs.get("http.url") or "")


def check_traces(traces: dict[str, list[Span]], *, clients: list[str], backend_url: str, path: str,
                 expect_requests: int | None = None, expect_traces: int | None = None,
                 backend_service: str = BACKEND_SERVICE, res: Result | None = None) -> Result:
    """Checks 1 to 4 and the trace half of 6 on already fetched traces (pure, unit tested)."""
    res = res or Result()
    server, client_reqs, orphans, foreign, no_session, wrong_session = [], [], [], [], [], []
    for tid, spans in traces.items():
        by_id = {s.span_id: s for s in spans}
        for s in spans:
            if s.service in clients and s.kind == "client" and span_url(s).startswith(backend_url):
                client_reqs.append(s)
            if s.service != backend_service or s.kind != "server":
                continue
            server.append(s)
            parent = by_id.get(s.parent_id)
            if not s.parent_id or parent is None:
                orphans.append(f"{tid[:8]}/{s.name} parent {s.parent_id or 'none'}")
                continue
            if parent.service not in clients:
                foreign.append(f"{tid[:8]}/{s.name} parent in {parent.service or '?'}")
            if path == "ouo":
                got, want = s.attrs.get("session.id"), parent.attrs.get("session.id")
                if not got:
                    no_session.append(f"{tid[:8]}/{s.name}")
                elif want and got != want:
                    wrong_session.append(f"{tid[:8]}/{s.name} {got} != {want}")

    res.add("backend server spans found", bool(server), f"{len(server)} in {len({s.trace_id for s in server})} traces")
    res.add("no orphan parents: every backend span's parent is in its trace", not orphans, "; ".join(orphans[:5]))
    res.add("one trace id from client to backend: the parent is an app client span", not foreign, "; ".join(foreign[:5]))
    if path == "ouo":
        res.add("session.id from baggage on every backend span", not no_session and not wrong_session,
                "; ".join((no_session + wrong_session)[:5]))
    joined = {s.parent_id for s in server}
    dropped = [f"{c.trace_id[:8]}/{c.name} {span_url(c)}" for c in client_reqs if c.span_id not in joined]
    res.add("no dropped traces: every client request to the backend has its backend span", not dropped,
            f"{len(client_reqs)} client requests" + ("; missing: " + "; ".join(dropped[:5]) if dropped else ""))
    if expect_requests is not None:
        res.add("backend requests equal the journey's requests", len(server) == expect_requests,
                f"{len(server)} backend spans, journey sent {expect_requests}")
    n_traces = len({s.trace_id for s in server})
    if expect_traces is not None:
        res.add("traces with backend spans equal the journey's traces", n_traces == expect_traces,
                f"{n_traces} traces, journey expects {expect_traces}")

    app_spans = [s for spans in traces.values() for s in spans if s.service in clients]
    bridged = [s for s in app_spans if "ouo.sentry.session_match" in s.attrs]
    if path == "sentry":
        res.add("client spans came through the Sentry bridge only", bool(app_spans) and len(bridged) == len(app_spans),
                f"{len(bridged)}/{len(app_spans)} bridged")
    else:
        res.add("no client span came through the Sentry bridge", not bridged, f"{len(bridged)} bridged")
    return res


def http_json(url: str, timeout: float = 15):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def tempo_search(tempo: str, q: str, start: int, end: int, limit: int = 1000) -> list[str]:
    qs = urllib.parse.urlencode({"q": q, "start": start, "end": end, "limit": limit, "spss": 100})
    doc = http_json(f"{tempo}/api/search?{qs}")
    # Tempo can return traces of the same blocks outside [start, end]: keep those that started in it
    # (a minute of slack for a client clock behind the host's).
    return [t["traceID"].lower().rjust(32, "0") for t in (doc or {}).get("traces", [])
            if start - 60 <= int(t.get("startTimeUnixNano", 0) or 0) / 1e9 <= end]


def fetch_traces(tempo: str, ids) -> dict[str, list[Span]]:
    out = {}
    for tid in ids:
        try:
            out[tid] = parse_trace(http_json(f"{tempo}/api/v2/traces/{tid}"))
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    return out


def backend_requests(loki: str, start: int, end: int) -> list[dict]:
    """The backend's `request` log lines (one per request, written whether or not its trace is
    sampled), each as its Loki labels: trace_id, flags (W3C trace flags, 1 = sampled), http_route."""
    qs = urllib.parse.urlencode({"query": f'{{service_name="{BACKEND_SERVICE}"}} |= "request"', "start": start * 10**9,
                                 "end": end * 10**9, "limit": 5000, "direction": "forward"})
    doc = http_json(f"{loki}/loki/api/v1/query_range?{qs}")
    return [s["stream"] for s in doc["data"]["result"] for _, line in s["values"] if line == "request"]


def check_backend_log(reqs: list[dict], traces: dict[str, list[Span]], res: Result) -> None:
    """Every request the backend served (its log) is a sampled trace whose backend span is in Tempo."""
    seen = {s.trace_id for spans in traces.values() for s in spans if s.service == BACKEND_SERVICE and s.kind == "server"}
    unsampled = [r.get("trace_id", "?")[:8] for r in reqs if r.get("flags") not in ("1", "01")]
    missing = [r.get("trace_id", "?")[:8] for r in reqs if r.get("trace_id", "").rjust(32, "0") not in seen]
    res.add("every request the backend logged was sampled (traceparent flag 01)", not unsampled,
            f"{len(reqs)} requests" + (f"; unsampled: {', '.join(unsampled[:5])}" if unsampled else ""))
    res.add("every request the backend logged has its trace in Tempo", bool(reqs) and not missing,
            f"{len(reqs) - len(missing)}/{len(reqs)}" + (f"; missing: {', '.join(missing[:5])}" if missing else ""))


def check_cors(backend_url: str, origin: str, sentry: bool, res: Result) -> None:
    headers = W3C_HEADERS + (["sentry-trace"] if sentry else [])
    req = urllib.request.Request(f"{backend_url}/api/products", method="OPTIONS", headers={
        "Origin": origin, "Access-Control-Request-Method": "GET",
        # Browsers send the list lowercase and sorted.
        "Access-Control-Request-Headers": ",".join(sorted(headers + ["content-type"]))})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            status, allow, allow_origin = r.status, r.headers.get("Access-Control-Allow-Headers", ""), r.headers.get("Access-Control-Allow-Origin", "")
    except urllib.error.HTTPError as e:
        status, allow, allow_origin = e.code, e.headers.get("Access-Control-Allow-Headers", ""), e.headers.get("Access-Control-Allow-Origin", "")
    allowed = {h.strip().lower() for h in allow.split(",")}
    missing = [h for h in headers if h not in allowed]
    res.add(f"CORS preflight allows {', '.join(headers)}", status in (200, 204) and allow_origin == origin and not missing,
            f"status {status}, allow-origin {allow_origin!r}, missing {missing}" if missing or status not in (200, 204) or allow_origin != origin else "")


def run(*, tempo: str, backend_url: str, clients: list[str], path: str, start: int, end: int,
        expect_requests: int | None = None, expect_traces: int | None = None, origin: str = "http://localhost:5173",
        settle: int = 90, loki: str | None = None, res: Result | None = None) -> Result:
    """Fetch the window's traces from Tempo (waiting up to `settle` s for ingestion) and check them.
    With `loki`, the backend's own request log is the reference: every request it served must be a
    sampled trace in Tempo, and the request count defaults to the number of log lines."""
    res = res or Result()
    print(f"trace continuity ({path} path, clients {', '.join(clients)}, backend {backend_url})", flush=True)
    check_cors(backend_url, origin, path == "sentry", res)
    svc = " || ".join(f'resource.service.name = "{c}"' for c in clients)
    deadline, prev, traces, reqs = time.time() + settle, None, {}, []
    while True:
        reqs = backend_requests(loki, start, end) if loki else []
        want = expect_requests if expect_requests is not None else (len(reqs) if loki else None)
        ids = {r["trace_id"].rjust(32, "0") for r in reqs if r.get("trace_id")}
        ids |= set(tempo_search(tempo, f'{{ resource.service.name = "{BACKEND_SERVICE}" && kind = server }}', start, end))
        ids |= set(tempo_search(tempo, f"{{ ({svc}) && kind = client }}", start, end))
        # Tempo's search can return older traces of the same blocks: keep those that started in the window.
        traces = {tid: spans for tid, spans in fetch_traces(tempo, sorted(ids)).items()
                  if any(start <= s.start <= end for s in spans)}
        n = sum(len(v) for v in traces.values())
        enough = want is None or sum(1 for v in traces.values() for s in v if s.service == BACKEND_SERVICE and s.kind == "server") >= want
        if (n and n == prev and enough) or time.time() > deadline:
            break
        prev = n
        time.sleep(10)
    if loki:
        check_backend_log(reqs, traces, res)
    check_traces(traces, clients=clients, backend_url=backend_url, path=path,
                 expect_requests=want, expect_traces=expect_traces, res=res)
    mixed = []
    for mode in (("parallel", "ouo") if path == "sentry" else ("sentry",)):
        mixed += tempo_search(tempo, f'{{ resource.ouo.rum.mode = "{mode}" }}', start, end)
    res.add("never the ouo SDK and the Sentry bridge into ouo at once", not mixed,
            f"{len(mixed)} traces from the other SDK path in the window" if mixed else "")
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tempo", required=True)
    ap.add_argument("--backend-url", required=True)
    ap.add_argument("--client", action="append", required=True, help="client service.name (repeatable)")
    ap.add_argument("--path", choices=["ouo", "sentry"], required=True)
    ap.add_argument("--start", type=int, required=True, help="unix seconds")
    ap.add_argument("--end", type=int, required=True, help="unix seconds")
    ap.add_argument("--expect-requests", type=int)
    ap.add_argument("--expect-traces", type=int)
    ap.add_argument("--origin", default="http://localhost:5173")
    ap.add_argument("--loki", help="Loki URL: check against the backend's request log")
    a = ap.parse_args(argv)
    res = run(tempo=a.tempo.rstrip("/"), backend_url=a.backend_url.rstrip("/"), clients=a.client, path=a.path,
              start=a.start, end=a.end, expect_requests=a.expect_requests, expect_traces=a.expect_traces, origin=a.origin,
              loki=a.loki.rstrip("/") if a.loki else None)
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
