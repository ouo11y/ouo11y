#!/usr/bin/env python3
"""Print what ffprobe would about a Sentry mobile replay segment, with the standard library only.

    python3 -I scripts/mp4info.py <segment.mp4> [...]     one JSON object per file

Reads the ISO BMFF boxes: brands (ftyp), duration and timescale (mvhd/mdhd), codec (stsd: avc1 +
avcC profile/level, or hvc1), coded width/height, sample (frame) count (stsz), keyframes (stss),
sample durations (stts) and the bit rate (mdat bytes * 8 / duration). Written for the Step 6 wire
captures (project/kb/vendor-internals/sentry/mobile-sdks/replay-mobile.md) because ffprobe is not
installed on this Mac.
"""
import json
import struct
import sys

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"udta"}
PROFILES = {66: "Baseline", 77: "Main", 88: "Extended", 100: "High"}


def boxes(data, start, end):
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
            header = 16
        elif size == 0:
            size = end - i
        if size < header:
            return
        yield kind, i + header, i + size
        i += size


def walk(data, start, end, out, track):
    for kind, s, e in boxes(data, start, end):
        if kind == b"ftyp":
            out["major_brand"] = data[s:s + 4].decode("latin1")
            out["compatible_brands"] = [data[j:j + 4].decode("latin1") for j in range(s + 8, e, 4)]
        elif kind == b"mvhd":
            v = data[s]
            ts, dur = struct.unpack(">IQ" if v else ">II", data[s + 20:s + 32] if v else data[s + 12:s + 20])
            out["duration_s"] = round(dur / ts, 3) if ts else None
        elif kind == b"trak":
            t = {}
            walk(data, s, e, out, t)
            out.setdefault("tracks", []).append(t)
        elif kind == b"mdhd":
            v = data[s]
            ts, dur = struct.unpack(">IQ" if v else ">II", data[s + 20:s + 32] if v else data[s + 12:s + 20])
            track["timescale"] = ts
            track["duration_s"] = round(dur / ts, 3) if ts else None
        elif kind == b"hdlr":
            track["handler"] = data[s + 8:s + 12].decode("latin1")
        elif kind == b"stsd":
            entry = s + 8
            size, fmt = struct.unpack(">I4s", data[entry:entry + 8])
            track["codec_tag"] = fmt.decode("latin1")
            w, h = struct.unpack(">HH", data[entry + 32:entry + 36])
            track["width"], track["height"] = w, h
            for k, cs, ce in boxes(data, entry + 86, entry + size):
                if k == b"avcC":
                    track["codec"] = "h264"
                    track["profile"] = PROFILES.get(data[cs + 1], data[cs + 1])
                    track["level"] = data[cs + 3] / 10
                elif k == b"hvcC":
                    track["codec"] = "hevc"
        elif kind == b"stsz":
            fixed, count = struct.unpack(">II", data[s + 4:s + 12])
            track["frames"] = count
        elif kind == b"stss":
            track["keyframes"] = struct.unpack(">I", data[s + 4:s + 8])[0]
        elif kind == b"stts":
            n = struct.unpack(">I", data[s + 4:s + 8])[0]
            track["sample_deltas"] = [list(struct.unpack(">II", data[s + 8 + 8 * j:s + 16 + 8 * j])) for j in range(min(n, 8))]
        elif kind == b"mdat":
            out["mdat_bytes"] = e - s
        elif kind in CONTAINERS:
            walk(data, s, e, out, track)


def info(path):
    data = open(path, "rb").read()
    out = {"file": path, "size_bytes": len(data)}
    walk(data, 0, len(data), out, {})
    video = next((t for t in out.get("tracks", []) if t.get("handler") == "vide"), {})
    dur = video.get("duration_s") or out.get("duration_s")
    if dur and video.get("frames"):
        out["avg_fps"] = round(video["frames"] / dur, 3)
    if dur and out.get("mdat_bytes"):
        out["avg_bitrate_bps"] = round(out["mdat_bytes"] * 8 / dur)
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(info(p)))
