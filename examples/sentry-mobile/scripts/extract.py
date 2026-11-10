#!/usr/bin/env python3
"""Decode every envelope of a sentrytap capture into readable files, and summarise it as JSON.

    python3 -I scripts/extract.py <capture dir> <out dir>

For request NNNNNN it writes <out>/NNNNNN/envelope-header.json, one item-<i>-<type>.json per JSON
item (item header + payload), and for replay_video items replay_event.json, replay_recording.json
(segment header + rrweb events) and replay_video.mp4. <out>/summary.json lists per request: time,
compressed/uncompressed bytes, user agent, sdk name, item types and sizes, and for replay segments
replay id, segment id, key order, part sizes and the video event payload. <out>/ids.json collects
event, transaction, trace, replay and session ids. Written for the Step 6 wire captures
(project/kb/vendor-internals/sentry/mobile-sdks/wire-capture.md); reuses scripts/analyze.py.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import Msgpack, decode_body, load_requests, parse_envelope  # noqa: E402


def main(run, out):
    os.makedirs(out, exist_ok=True)
    summary, ids = [], {"events": [], "transactions": [], "replays": {}, "sessions": [], "traces": set(), "feedback": [], "profiles": []}
    for r in load_requests(run):
        seq = str(r["n"]).zfill(6) if isinstance(r["n"], int) else str(r["n"])
        raw = open(os.path.join(run, r["file"]), "rb").read()
        body = decode_body(raw, r["content_encoding"])
        meta = json.load(open(os.path.join(run, r["file"].replace("body.bin", "request.json"))))
        d = os.path.join(out, seq)
        os.makedirs(d, exist_ok=True)
        try:
            header, items = parse_envelope(body)
        except Exception as e:  # not an envelope
            summary.append({"seq": seq, "path": r["path"], "error": str(e)})
            continue
        json.dump(header, open(os.path.join(d, "envelope-header.json"), "w"), indent=1)
        rec = {
            "seq": seq, "time": meta.get("time"), "path": r["path"],
            "content_encoding": r["content_encoding"], "wire_bytes": len(raw), "envelope_bytes": len(body),
            "user_agent": r["headers"].get("User-Agent"), "sdk": (header.get("sdk") or {}).get("name"),
            "sdk_version": (header.get("sdk") or {}).get("version"), "envelope_header_keys": sorted(header),
            "items": [],
        }
        if header.get("trace", {}).get("trace_id"):
            ids["traces"].add(header["trace"]["trace_id"])
        for i, (ih, payload) in enumerate(items):
            t = ih.get("type")
            it = {"type": t, "header": ih, "bytes": len(payload)}
            if t == "replay_video":
                mp = Msgpack(payload)
                m = mp.read()
                it["msgpack_layout"] = mp.trace
                it["key_order"] = list(m)
                ev = json.loads(m["replay_event"])
                json.dump(ev, open(os.path.join(d, "replay_event.json"), "w"), indent=1)
                rr = m.get("replay_recording", b"")
                seg_hdr, _, events = rr.partition(b"\n")
                events = json.loads(events) if events else []
                json.dump({"segment_header": json.loads(seg_hdr), "events": events}, open(os.path.join(d, "replay_recording.json"), "w"), indent=1)
                if m.get("replay_video"):
                    open(os.path.join(d, "replay_video.mp4"), "wb").write(m["replay_video"])
                it["parts"] = {k: len(v) for k, v in m.items()}
                it["replay_id"] = ev.get("replay_id")
                it["segment_id"] = ev.get("segment_id")
                it["replay_type"] = ev.get("replay_type")
                it["platform"] = ev.get("platform")
                kinds = {}
                for e in events:
                    k = f"type{e.get('type')}" + (f":{e['data'].get('tag')}" if e.get("type") == 5 else f":source{e.get('data', {}).get('source')}" if e.get("type") == 3 else "")
                    kinds[k] = kinds.get(k, 0) + 1
                it["recording_events"] = kinds
                it["video"] = next((e["data"]["payload"] for e in events if e.get("type") == 5 and e["data"].get("tag") == "video"), None)
                ids["replays"].setdefault(ev.get("replay_id"), []).append(ev.get("segment_id"))
                for tid in ev.get("trace_ids") or []:
                    ids["traces"].add(tid)
            else:
                ext = "json"
                try:
                    obj = json.loads(payload)
                except Exception:
                    obj = None
                    ext = "bin"
                name = f"item-{i}-{t}.{ext}"
                if obj is not None:
                    json.dump({"item_header": ih, "payload": obj}, open(os.path.join(d, name), "w"), indent=1)
                    if t == "event":
                        ids["events"].append({"seq": seq, "event_id": obj.get("event_id"), "level": obj.get("level"),
                                              "exception": [(x.get("type"), (x.get("mechanism") or {}).get("type")) for x in (obj.get("exception") or {}).get("values", [])],
                                              "message": (obj.get("message") or {}).get("formatted") if isinstance(obj.get("message"), dict) else obj.get("message"),
                                              "replay_id": (obj.get("contexts") or {}).get("replay", {}).get("replay_id"),
                                              "trace_id": (obj.get("contexts") or {}).get("trace", {}).get("trace_id"), "sdk": header.get("sdk", {}).get("name")})
                    elif t == "transaction":
                        ids["transactions"].append({"seq": seq, "event_id": obj.get("event_id"), "name": obj.get("transaction"),
                                                    "op": (obj.get("contexts") or {}).get("trace", {}).get("op"),
                                                    "trace_id": (obj.get("contexts") or {}).get("trace", {}).get("trace_id"),
                                                    "spans": len(obj.get("spans") or []), "measurements": sorted(obj.get("measurements") or {})})
                    elif t == "session":
                        ids["sessions"].append({"seq": seq, "sid": obj.get("sid"), "status": obj.get("status"), "init": obj.get("init"),
                                                "seq_no": obj.get("seq"), "errors": obj.get("errors"), "duration": obj.get("duration"),
                                                "started": obj.get("started"), "timestamp": obj.get("timestamp")})
                    elif t == "feedback":
                        ids["feedback"].append({"seq": seq, "event_id": obj.get("event_id")})
                    elif t in ("profile", "profile_chunk"):
                        ids["profiles"].append({"seq": seq, "type": t, "id": obj.get("event_id") or obj.get("chunk_id") or obj.get("profile_id")})
                else:
                    open(os.path.join(d, name), "wb").write(payload)
            rec["items"].append(it)
        summary.append(rec)
    ids["traces"] = sorted(ids["traces"])
    json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)
    json.dump(ids, open(os.path.join(out, "ids.json"), "w"), indent=1)
    counts = {}
    for s in summary:
        for it in s.get("items", []):
            counts[it["type"]] = counts.get(it["type"], 0) + 1
    print(json.dumps({"requests": len(summary), "items": counts}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
