#!/usr/bin/env python3
"""APK size per variant (release, R8 + resource shrinking, arm64-v8a only, debug-signed).
size_bytes = sum of uncompressed entries (what the install unpacks), size_zipped_bytes = APK file size
(the download, before Play's per-device split). Writes out/sizes.json."""
import glob, json, os, zipfile
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
res = {}
for apk in sorted(glob.glob(f"{root}/host/app/build/outputs/apk/*/release/*.apk")):
    v = apk.split("/apk/")[1].split("/")[0]
    z = zipfile.ZipFile(apk)
    ent = [i for i in z.infolist() if not i.filename.startswith("META-INF/")]
    res[v] = {"apk_bytes": os.path.getsize(apk), "uncompressed_bytes": sum(i.file_size for i in ent),
              "dex_bytes": sum(i.file_size for i in ent if i.filename.endswith(".dex")),
              "native_bytes": sum(i.file_size for i in ent if i.filename.endswith(".so")),
              "native_libs": [i.filename for i in ent if i.filename.endswith(".so")]}
b = res["baseline"]
for v in res:
    res[v]["delta_apk_bytes"] = res[v]["apk_bytes"] - b["apk_bytes"]
    res[v]["delta_uncompressed_bytes"] = res[v]["uncompressed_bytes"] - b["uncompressed_bytes"]
    res[v]["delta_dex_bytes"] = res[v]["dex_bytes"] - b["dex_bytes"]
json.dump(res, open(f"{root}/out/sizes.json", "w"), indent=1)
for v, r in res.items(): print(f"{v:13} apk {r['apk_bytes']:>8} (+{r['delta_apk_bytes']:>8})  unzipped +{r['delta_uncompressed_bytes']:>8}  dex +{r['delta_dex_bytes']:>8}  so {r['native_bytes']}")
