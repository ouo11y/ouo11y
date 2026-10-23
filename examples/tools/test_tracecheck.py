"""Unit tests for tracecheck.py: python3 -I -m unittest discover -s examples/tools"""

import io
import unittest
from contextlib import redirect_stdout

import tracecheck as tc

BACKEND = "http://localhost:8081"


def span(tid, sid, parent, service, kind, **attrs):
    return tc.Span(trace_id=tid, span_id=sid, parent_id=parent, name=f"{service}-{kind}", kind=kind,
                   service=service, attrs=attrs, resource={"service.name": service})


def good_trace(tid, n, session="s1", **client_attrs):
    """One fetch: app client span, backend server span under it."""
    c = f"{n:016x}"
    return [span(tid, c, "", "app", "client", **{"url.full": f"{BACKEND}/api/products", "session.id": session, **client_attrs}),
            span(tid, f"{n + 100:016x}", c, tc.BACKEND_SERVICE, "server", **{"session.id": session})]


def run(traces, **kw):
    kw.setdefault("clients", ["app"])
    kw.setdefault("backend_url", BACKEND)
    kw.setdefault("path", "ouo")
    with redirect_stdout(io.StringIO()):
        res = tc.check_traces(traces, **kw)
    return {name: ok for name, ok, _ in res.checks}, res.ok


class CheckTraces(unittest.TestCase):
    def test_good_ouo_path(self):
        traces = {"a" * 32: good_trace("a" * 32, 1), "b" * 32: good_trace("b" * 32, 2)}
        checks, ok = run(traces, expect_requests=2, expect_traces=2)
        self.assertTrue(ok, checks)

    def test_orphan_parent(self):
        t = good_trace("a" * 32, 1)
        t[1].parent_id = "ffffffffffffffff"  # Sentry without an active transaction
        checks, ok = run({"a" * 32: t})
        self.assertFalse(ok)
        self.assertFalse(checks["no orphan parents: every backend span's parent is in its trace"])
        self.assertFalse(checks["no dropped traces: every client request to the backend has its backend span"])

    def test_dropped_trace(self):
        t = good_trace("a" * 32, 1)[:1]  # unsampled: the backend recorded nothing
        checks, ok = run({"a" * 32: t, "b" * 32: good_trace("b" * 32, 2)}, expect_requests=2)
        self.assertFalse(checks["no dropped traces: every client request to the backend has its backend span"])
        self.assertFalse(checks["backend requests equal the journey's requests"])

    def test_missing_session_on_ouo_path_only(self):
        t = good_trace("a" * 32, 1)
        del t[1].attrs["session.id"]
        checks, _ = run({"a" * 32: t})
        self.assertFalse(checks["session.id from baggage on every backend span"])
        t[0].attrs["ouo.sentry.session_match"] = "device"
        checks, ok = run({"a" * 32: t}, path="sentry")
        self.assertTrue(ok, checks)

    def test_parent_in_other_service(self):
        t = good_trace("a" * 32, 1)
        t[0].service = "someone-else"
        checks, _ = run({"a" * 32: t})
        self.assertFalse(checks["one trace id from client to backend: the parent is an app client span"])

    def test_bridge_mixing(self):
        t = good_trace("a" * 32, 1, **{"ouo.sentry.session_match": "replay"})
        checks, _ = run({"a" * 32: t}, path="ouo")
        self.assertFalse(checks["no client span came through the Sentry bridge"])
        checks, _ = run({"a" * 32: good_trace("b" * 32, 2)}, path="sentry")
        self.assertFalse(checks["client spans came through the Sentry bridge only"])

    def test_backend_log_reference(self):
        traces = {"a" * 32: good_trace("a" * 32, 1)}
        res = tc.Result()
        with redirect_stdout(io.StringIO()):
            tc.check_backend_log([{"trace_id": "a" * 32, "flags": "1"}, {"trace_id": "b" * 32, "flags": "0"}], traces, res)
        self.assertEqual([ok for _, ok, _ in res.checks], [False, False])
        res = tc.Result()
        with redirect_stdout(io.StringIO()):
            tc.check_backend_log([{"trace_id": "a" * 32, "flags": "1"}], traces, res)
        self.assertTrue(res.ok)

    def test_parse_v2_trace_base64_ids(self):
        doc = {"trace": {"resourceSpans": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "demo-backend"}}]},
                                             "scopeSpans": [{"spans": [{"traceId": "AAECAwQFBgcICQoLDA0ODw==", "spanId": "AAECAwQFBgc=",
                                                                        "parentSpanId": "CAkKCwwNDg8=", "kind": "SPAN_KIND_SERVER", "name": "GET",
                                                                        "attributes": [{"key": "session.id", "value": {"stringValue": "s"}}]}]}]}]}}
        (s,) = tc.parse_trace(doc)
        self.assertEqual((s.trace_id, s.span_id, s.parent_id, s.kind, s.service, s.attrs["session.id"]),
                         ("000102030405060708090a0b0c0d0e0f", "0001020304050607", "08090a0b0c0d0e0f", "server", "demo-backend", "s"))


if __name__ == "__main__":
    unittest.main()
