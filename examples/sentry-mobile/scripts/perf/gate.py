#!/usr/bin/env python3
"""Release gate (docs/benchmarks.md section 5): does a new @ouo11y/react-native cost more than the
previous release, beyond the agreed thresholds?

    python3 -I gate.py --new <result.json> --base <result.json> [--md gate.md]

Both results must come from the same machine in the same workflow run. For every ouo cell, the
paired median delta against `none` of the new version is compared with the base version's. A metric
fails when it is worse by more than the threshold (the larger of the absolute and relative one)
AND the new median lies outside the base's IQR. Exit code 1 when any metric fails (blocks the
release), 0 otherwise. The comparison against Sentry never blocks.
"""
import argparse
import json
import sys

# key: (label, absolute threshold, relative threshold, unit). None = not used.
THRESHOLDS = {
    "cpu_pct": ("CPU journey average", 2.0, 0.15, "pp"),
    "idle_cpu_pct": ("CPU idle overhead", 1.0, 0.15, "pp"),
    "steady_mb": ("steady memory", 5.0, 0.10, "MB"),
    "sdk_up_kb": ("SDK bytes up (wire)", None, 0.10, "KB"),
    "start_ms": ("added startup", 50.0, None, "ms"),
    "dropped_pct": ("JS frames dropped", 1.0, None, "% of frames"),
    "energy_mj": ("energy", None, 0.10, "mJ"),
}
SOAK = ("memory growth over the soak", 10.0, "MB/h")
SIZE = ("app binary + JS bundle added", 0.10)


def allowed(base, absolute, relative):
    a = absolute if absolute is not None else 0.0
    r = abs(base) * relative if relative is not None else 0.0
    return max(a, r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--md")
    a = ap.parse_args()
    new, base = json.load(open(a.new)), json.load(open(a.base))
    nv = new["meta"]["versions"].get("@ouo11y/react-native")
    bv = base["meta"]["versions"].get("@ouo11y/react-native")
    lines = [f"## Benchmark gate: @ouo11y/react-native {nv} vs {bv}", "",
             "| Cell | Metric | Base added | New added | Worse by | Allowed | Result |", "|---|---|---|---|---|---|---|"]
    failed = []
    for cell in sorted(c for c in new["vs_none"] if c.startswith("ouo-")):
        n, b = new["vs_none"].get(cell) or {}, base["vs_none"].get(cell) or {}
        for key, (label, ab, rel, unit) in THRESHOLDS.items():
            gn, gb = n.get(key), b.get(key)
            if not gn or not gb:
                continue
            worse = gn["median"] - gb["median"]
            lim = allowed(gb["median"], ab, rel)
            outside = gn["median"] > gb["q3"]
            bad = worse > lim and outside
            res = "**FAIL**" if bad else ("worse, within threshold or IQR" if worse > 0 else "ok")
            lines.append(f"| {cell} | {label} | {gb['median']:+.2f} {unit} | {gn['median']:+.2f} {unit} | {worse:+.2f} | {lim:.2f} | {res} |")
            if bad:
                failed.append(f"{cell} {label}: {worse:+.2f} {unit} (allowed {lim:.2f})")
    for cell, s in (new.get("soak") or {}).items():
        if cell.startswith("ouo-") and (base.get("soak") or {}).get(cell):
            gn, gb = s.get("growth_mb_h"), base["soak"][cell].get("growth_mb_h")
            if gn is not None and gb is not None:
                worse = gn - gb
                bad = worse > SOAK[1]
                lines.append(f"| {cell} soak | {SOAK[0]} | {gb:+.1f} | {gn:+.1f} | {worse:+.1f} | {SOAK[1]:.1f} | {'**FAIL**' if bad else 'ok'} |")
                if bad:
                    failed.append(f"{cell} {SOAK[0]}: {worse:+.1f} MB/h")

    def ouo_size(r):
        s = r.get("size") or {}
        return sum((s.get(k) or {}).get("groups", {}).get("ouo", 0) for k in ("native", "js")) or None

    sn, sb = ouo_size(new), ouo_size(base)
    if sn and sb:
        worse = sn - sb
        lim = sb * SIZE[1]
        bad = worse > lim
        lines.append(f"| size | {SIZE[0]} | {sb / 1024:.0f} KB | {sn / 1024:.0f} KB | {worse / 1024:+.0f} KB | {lim / 1024:.0f} KB | {'**FAIL**' if bad else 'ok'} |")
        if bad:
            failed.append(f"{SIZE[0]}: {worse / 1024:+.0f} KB")
    lines += ["", f"**{'BLOCKED' if failed else 'PASSED'}**" + (": " + "; ".join(failed) if failed else ""),
              "", "Thresholds: docs/benchmarks.md section 5. The founder can override a block with a written reason on the release PR."]
    text = "\n".join(lines)
    print(text)
    if a.md:
        open(a.md, "w").write(text + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
