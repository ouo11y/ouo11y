# extract.py <collector-out> <images-dir>: frames bodies -> one JPEG per frame/patch event
# (<stream>-<seq>-<n>-<t>.jpg); video chunks -> the mp4 (already written) plus times.json mapping
# each mp4 to its segment start and fps. Run with python3 -I.
import base64, glob, gzip, json, os, sys
out, img = sys.argv[1], sys.argv[2]
os.makedirs(img, exist_ok=True)
times = {}
for rec in open(os.path.join(out, "records.jsonl")):
    r = json.loads(rec)
    if r.get("event") != "ouo.replay.chunk": continue
    a = r["attributes"]
    base = "%s-%s" % (a["ouo.replay.stream.id"], a["ouo.replay.sequence"])
    if a["ouo.replay.format"] == "ouo-video/1":
        times[base + ".mp4"] = {"start": a["ouo.replay.start_time"], "end": a["ouo.replay.end_time"], "bytes": r["bodyBytes"]}
        src = os.path.join(out, base + ".mp4")
        dst = os.path.join(img, base + ".mp4")
        if os.path.exists(src) and not os.path.exists(dst): os.link(src, dst)
    else:
        body = gzip.decompress(open(os.path.join(out, base + ".ndjson.gz"), "rb").read())
        for n, line in enumerate(body.splitlines()):
            e = json.loads(line)
            parts = [e["jpeg"]] if e.get("type") == "frame" else [p["jpeg"] for p in e.get("patches", [])]
            for k, j in enumerate(parts):
                name = "%s-%d-%d-%d.jpg" % (base, n, k, e["t"])
                open(os.path.join(img, name), "wb").write(base64.b64decode(j))
                times[name] = {"start": e["t"], "type": e["type"]}
json.dump(times, open(os.path.join(img, "times.json"), "w"), indent=1)
print(len(times), "items")
