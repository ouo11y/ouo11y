"""Unit tests for sentryreplay.py: python3 -I -m unittest discover -s examples/tools"""

import gzip
import hashlib
import json
import unittest

import sentryreplay as sr

DAY = 86400.0


class RewriterTest(unittest.TestCase):
    def test_iso_strings_move_and_keep_their_shape(self):
        rw = sr.Rewriter(DAY)
        self.assertEqual(rw.string("2026-10-23T11:05:25.677Z"), "2026-10-24T11:05:25.677Z")
        self.assertEqual(rw.string("2026-10-23T11:05:25Z"), "2026-10-24T11:05:25Z")
        self.assertEqual(rw.string("2026-10-23T23:59:59.123456+00:00"), "2026-10-24T23:59:59.123456+00:00")

    def test_epoch_seconds_and_milliseconds_move_small_numbers_do_not(self):
        rw = sr.Rewriter(DAY)
        self.assertEqual(rw.number(1792753525.5), 1792753525.5 + DAY)
        self.assertEqual(rw.number(1792753525), 1792753525 + int(DAY))
        self.assertEqual(rw.number(1792753525704), 1792753525704 + int(DAY * 1000))
        for v in (0, 1, 402, 874, 34584, 2.5, True):
            self.assertEqual(rw.number(v), v)

    def test_ids_map_consistently_across_spellings(self):
        rw = sr.Rewriter(0)
        dashed = rw.string("96297C3D-8B2B-457A-AF84-B85B15B3C554")
        plain = rw.string("96297c3d8b2b457aaf84b85b15b3c554")
        self.assertNotEqual(plain, "96297c3d8b2b457aaf84b85b15b3c554")
        self.assertEqual(dashed.replace("-", "").lower(), plain)
        self.assertEqual(dashed, dashed.upper())
        self.assertEqual(dashed.count("-"), 4)
        # sentry-trace header: the trace id is mapped, the 16-hex span id and the flag stay
        self.assertEqual(rw.string("96297c3d8b2b457aaf84b85b15b3c554-a1b2c3d4e5f60718-1"), plain + "-a1b2c3d4e5f60718-1")
        sha = "ab" * 32
        self.assertEqual(rw.string(sha), sha)

    def test_debug_ids_are_kept(self):
        rw = sr.Rewriter(0)
        img = {"debug_id": "96297c3d-8b2b-457a-af84-b85b15b3c554", "trace_id": "96297c3d8b2b457aaf84b85b15b3c554"}
        out = rw.walk(img)
        self.assertEqual(out["debug_id"], img["debug_id"])
        self.assertNotEqual(out["trace_id"], img["trace_id"])
        self.assertIn(out["trace_id"], rw.traces)

    def test_msgpack_round_trip(self):
        pairs = [("replay_event", b'{"a":1}'), ("replay_video", bytes(range(256)) * 300)]
        self.assertEqual(sr.mp_read_map(sr.mp_write_map(pairs)), pairs)


class GoldenCaptureTest(unittest.TestCase):
    """Every golden envelope rewrites, parses back, and keeps its mp4 bytes."""

    def test_golden_journey(self):
        reqs = sr.load_capture(sr.DEFAULT_CAPTURE)
        rw = sr.Rewriter(30 * DAY)
        videos_in, videos_out = [], []
        for meta, body in reqs:
            plain = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
            new = sr.rewrite_envelope(rw, plain)
            self.assertNotIn(b"2026-10-", new, meta["seq"])
            videos_in += mp4s(plain)
            videos_out += mp4s(new)
        self.assertEqual(videos_in, videos_out)
        self.assertEqual(len(videos_out), 20)
        self.assertEqual(len(rw.sessions), 4)
        self.assertEqual(len(rw.replays), 4)


def mp4s(envelope):
    """sha256 of every replay_video mp4 in an envelope, parsing item lengths strictly."""
    out = []
    _, _, rest = envelope.partition(b"\n")
    while rest.strip():
        ih_raw, _, rest = rest.partition(b"\n")
        ih = json.loads(ih_raw)
        n = ih["length"]
        payload, rest = rest[:n], rest[n:]
        assert len(payload) == n
        rest = rest[1:] if rest[:1] == b"\n" else rest
        if ih["type"] == "replay_video":
            out.append(hashlib.sha256(dict(sr.mp_read_map(payload))["replay_video"]).hexdigest())
    return out


if __name__ == "__main__":
    unittest.main()
