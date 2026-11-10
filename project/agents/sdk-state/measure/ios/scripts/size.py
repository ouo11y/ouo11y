#!/usr/bin/env python3
"""Sizes of the built apps: uncompressed .app bytes, the executable alone, and a zipped Payload/
(an IPA-shaped zip, deflate level 9 as `zip -9`), for the device (dev) and simulator (sim) builds.
    python3 -I size.py <build dir>   -> JSON on stdout"""
import json, os, shutil, subprocess, sys, tempfile, zipfile, io

def tree(p):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(p) for f in fs if not os.path.islink(os.path.join(d, f)))

def zipped(app):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for d, _, fs in os.walk(app):
            for f in sorted(fs):
                full = os.path.join(d, f)
                z.write(full, os.path.join("Payload", "Bench.app", os.path.relpath(full, app)))
    return len(buf.getvalue())

def stripped(exe):
    """Executable size after  (what an App Store export strips); on a copy."""
    with tempfile.TemporaryDirectory() as d:
        c = os.path.join(d, "Bench")
        shutil.copy(exe, c)
        subprocess.run(["xcrun", "strip", "-rSTx", c], capture_output=True)
        return os.path.getsize(c)


b = sys.argv[1]
out = {}
for v in ("base", "ouo", "sentry"):
    for kind in ("dev", "sim"):
        app = os.path.join(b, v, kind, "Bench.app")
        if not os.path.isdir(app):
            continue
        out.setdefault(v, {})[kind] = {"app_bytes": tree(app), "exe_bytes": os.path.getsize(os.path.join(app, "Bench")),
                                       "zipped_bytes": zipped(app), "exe_stripped_bytes": stripped(os.path.join(app, "Bench"))}
for v in out:
    for kind in out[v]:
        base = out.get("base", {}).get(kind)
        if base:
            out[v][kind]["delta_app_bytes"] = out[v][kind]["app_bytes"] - base["app_bytes"]
            out[v][kind]["delta_exe_stripped_bytes"] = out[v][kind]["exe_stripped_bytes"] - base["exe_stripped_bytes"]
            out[v][kind]["delta_zipped_bytes"] = out[v][kind]["zipped_bytes"] - base["zipped_bytes"]
print(json.dumps(out, indent=1))
