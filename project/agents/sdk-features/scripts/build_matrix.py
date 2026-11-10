#!/usr/bin/env python3
"""Build project/kb/client-sdk-features/feature-matrix.html from the Markdown entries.

Sources of truth, all in project/kb/client-sdk-features/:
  catalog.md       feature ids and names
  target-list.md   must / should / later / never, reasons, spec links
  vendors/*.md     one research file per vendor and platform group

Standard library only. Run from anywhere:
  python3 project/agents/sdk-features/scripts/build_matrix.py
  python3 project/agents/sdk-features/scripts/build_matrix.py --check   # fail if the HTML is stale
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
KB = ROOT / "project/kb/client-sdk-features"
OUT = KB / "feature-matrix.html"

GROUPS = [
    ("SES", "Sessions"), ("ERR", "Errors and crashes"), ("PERF", "Performance and vitals"),
    ("NET", "Network"), ("INT", "Interactions"), ("NAV", "Navigation"), ("RPL", "Replay"),
    ("USR", "User and attributes"), ("LOG", "Logs"), ("SMP", "Sampling"), ("PRV", "Privacy"),
    ("TRN", "Offline and transport"), ("CFG", "Configuration"), ("API", "Manual instrumentation API"),
    ("SYM", "Source maps and symbolication"), ("FWK", "Framework integrations"),
    ("REL", "Release and versioning"), ("FF", "Feature flags"), ("FB", "User feedback"), ("OTH", "Other"),
]
GROUP_IDS = {g for g, _ in GROUPS}
VENDORS = ["sentry", "datadog", "posthog"]
VENDOR_NAMES = {"sentry": "Sentry", "datadog": "Datadog", "posthog": "PostHog"}
PLATFORMS = ["web", "ios", "android", "rn"]
ID_RE = re.compile(r"^([A-Z]+)-([a-z0-9]+)$")


def split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip())[1:-1]
    return [c.strip().replace("\\|", "|") for c in cells]


def table_rows(text):
    for line in text.splitlines():
        if not line.startswith("| "):
            continue
        cells = split_row(line)
        m = ID_RE.match(cells[0]) if cells else None
        if m and m.group(1) in GROUP_IDS:
            yield cells


def status(text):
    t = text.strip().lower()
    if t in ("", "—", "-", "–") or t.startswith("— "):
        return "na"
    if t.startswith("via native"):
        return "yes"
    if t.startswith("opt-in"):
        return "partial"
    for key, words in (("na", ("n/a",)), ("yes", ("yes",)), ("partial", ("partial",)),
                       ("no", ("no",)), ("unc", ("uncertain",))):
        for w in words:
            if t == w or t.startswith(w + " ") or t.startswith(w + ",") or t.startswith(w + "(") or t.startswith(w + ";"):
                return key
    if "uncertain" in t:
        return "unc"
    if t.startswith("paid"):
        return "partial"
    return "other"


def wire_status(fid, has, detail):
    """TRN-g asks "is RUM sent as OTLP?", so a vendor format there is a no."""
    if fid == "TRN-g":
        return "partial" if "otlp" in (has + detail).lower() and "not otlp" not in (has + detail).lower() else "no"
    return status(has)


def catalog():
    names = {}
    for line in (KB / "catalog.md").read_text().splitlines():
        m = re.match(r"^- ([A-Z]+-[a-z0-9]+) (.+)$", line)
        if m:
            names[m.group(1)] = m.group(2)
    return names


def targets():
    out = {}
    for cells in table_rows((KB / "target-list.md").read_text()):
        if len(cells) == 6:
            fid, feature, target, where, why, spec = cells
            out[fid] = {"feature": feature, "target": target.lower(), "where": where, "why": why, "spec": spec}
    return out


def vendor_cells():
    """Return {fid: {vendor: {platform: {s, text}}}} and extras."""
    cells = {}
    extras = []
    for v in VENDORS:
        web = (KB / f"vendors/{v}-web.md").read_text()
        for c in table_rows(web):
            if len(c) < 7:
                continue
            fid, has, how, default, limits, source, date = c[:7]
            text = f"**{has}**. {how}. Default: {default}. Limits: {limits}. Source: {source} ({date})"
            entry = {"s": wire_status(fid, has, how), "text": text}
            cells.setdefault(fid, {}).setdefault(v, {})["web"] = entry
            if fid not in CATALOG:
                extras.append((fid, v, "web", how))
        mob = (KB / f"vendors/{v}-mobile.md").read_text()
        for c in table_rows(mob):
            if len(c) < 6:
                continue
            fid, ios, android, rn, conf, src = c[:6]
            for p, val in (("ios", ios), ("android", android), ("rn", rn)):
                text = f"**{val}**. {conf}. Sources: {src}"
                cells.setdefault(fid, {}).setdefault(v, {})[p] = {"s": wire_status(fid, val, conf), "text": text}
            if fid not in CATALOG:
                extras.append((fid, v, "mobile", conf))
    return cells, extras


def md_inline(text):
    """Escape, then render `code`, **bold** and [label](href)."""
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{html.escape(m.group(2))}">{m.group(1)}</a>', out)
    return out


CATALOG = catalog()


def main():
    tgt = targets()
    cells, extras = vendor_cells()
    missing = [f for f in CATALOG if f not in tgt]
    if missing:
        sys.exit(f"catalog ids without a target: {missing}")
    holes = [f"{f} {v} {p}" for f in CATALOG for v in VENDORS for p in PLATFORMS
             if p not in cells.get(f, {}).get(v, {})]
    if holes:
        sys.exit(f"catalog rows missing from a vendor file: {holes}")
    rows = []
    for fid, name in CATALOG.items():
        t = tgt[fid]
        rows.append({
            "id": fid, "g": fid.split("-")[0], "name": md_inline(t["feature"]), "full": md_inline(name),
            "target": t["target"], "where": t["where"], "why": md_inline(t["why"]), "spec": md_inline(t["spec"]),
            "cells": {v: {p: {"s": e["s"], "t": md_inline(e["text"])} for p, e in cells.get(fid, {}).get(v, {}).items()} for v in VENDORS},
        })
    extra_rows = []
    seen = set()
    for fid, v, kind, label in extras:
        key = (fid, v, kind)
        if key in seen:
            continue
        seen.add(key)
        plats = ["web"] if kind == "web" else ["ios", "android", "rn"]
        c = {v: {p: {"s": e["s"], "t": md_inline(e["text"])} for p, e in cells[fid][v].items() if p in plats}}
        extra_rows.append({"id": fid, "g": fid.split("-")[0], "vendor": VENDOR_NAMES[v], "kind": kind,
                           "name": md_inline(label[:140] + ("…" if len(label) > 140 else "")), "cells": c})
    counts = {k: sum(1 for r in rows if r["target"] == k) for k in ("must", "should", "later", "never")}
    data = {"groups": GROUPS, "vendors": VENDORS, "vnames": VENDOR_NAMES, "rows": rows, "extras": extra_rows, "counts": counts}
    page = TEMPLATE.replace("/*DATA*/", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    if "--check" in sys.argv:
        if OUT.read_text() != page:
            sys.exit(f"{OUT.relative_to(ROOT)} is stale: run build_matrix.py and commit the result")
        print(f"{OUT.relative_to(ROOT)} is up to date")
        return
    OUT.write_text(page)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} features, {len(extra_rows)} vendor extras, targets {counts}")


TEMPLATE = (Path(__file__).with_name("matrix_template.html.in")).read_text()

if __name__ == "__main__":
    main()
