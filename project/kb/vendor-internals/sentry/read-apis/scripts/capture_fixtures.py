#!/usr/bin/env python3
"""Capture redacted sample responses from Sentry's read APIs into ../fixtures/.

Read-only. Stdlib only. Usage:
  SENTRY_URL=http://localhost:9000 SENTRY_TOKEN=<token> python3 -I capture_fixtures.py \
      --web-replay <id> --web-project <slug> --mobile-replay <id> --mobile-project <slug> \
      --issue <id> --event <id> --event-project <slug> --trace <id>

Every response is saved as <name>.json with a sibling <name>.headers.txt (status line and the
headers that matter: Link, Content-*, X-Hits, X-Sentry-Rate-Limit-*). Secrets are redacted:
DSN keys, emails, IP addresses, avatar hashes, device hashes.
"""
import argparse, json, os, re, urllib.request, urllib.error

URL = os.environ.get("SENTRY_URL", "http://localhost:9000").rstrip("/")
TOKEN = os.environ["SENTRY_TOKEN"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures")
KEEP = ("link", "content-type", "content-length", "content-range", "accept-ranges", "content-disposition",
        "x-hits", "x-max-hits", "x-data-source", "x-sentry-rate-limit-limit", "x-sentry-rate-limit-remaining",
        "x-sentry-rate-limit-reset", "x-sentry-rate-limit-concurrentlimit", "x-sentry-rate-limit-concurrentremaining")

RULES = [
    (re.compile(r"(https?://)[0-9a-f]{32}(:[0-9a-f]{32})?@"), r"\1<redacted-key>@"),
    (re.compile(r'"(public|secret)":\s*"[0-9a-f]{32}"'), r'"\1": "<redacted-key>"'),
    (re.compile(r"sentry_key=[0-9a-f]{32}"), "sentry_key=<redacted-key>"),
    (re.compile(r"(sentry-public_key(=|%3D))[0-9a-f]{32}"), r"\1<redacted-key>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "user@example.invalid"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "0.0.0.0"),
    (re.compile(r"gravatar\.com/avatar/[0-9a-f]{32,64}"), "gravatar.com/avatar/<redacted>"),
    (re.compile(r'"(device_app_hash|hash|app\.device)":\s*"[0-9a-f]{32,64}"'), r'"\1": "<redacted>"'),
    (re.compile(r'"(key)":\s*"app\.device",\s*"value":\s*"[0-9a-f]{32,64}"'), r'"\1": "app.device", "value": "<redacted>"'),
    (re.compile(r"(sntrys_|sntryu_)[A-Za-z0-9_=+/]+"), r"\1<redacted>"),
]


def scrub_keys(keys):
    """Project keys: the key id IS the public key, and it is embedded in every DSN URL."""
    text = json.dumps(keys)
    for k in keys:
        for secret in (k.get("public"), k.get("secret"), k.get("id")):
            if secret:
                text = text.replace(secret, "<redacted-key>")
    return json.loads(text)


def redact(text):
    for rx, rep in RULES:
        text = rx.sub(rep, text)
    return text


def fetch(path, headers=None):
    req = urllib.request.Request(URL + path, headers={"Authorization": "Bearer " + TOKEN, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def save(name, path, headers=None, binary=False, trim=None):
    status, hdrs, body = fetch(path, headers)
    head = [f"GET {path}", f"HTTP {status}"] + [f"{k}: {v}" for k, v in hdrs.items() if k.lower() in KEEP]
    open(os.path.join(OUT, name + ".headers.txt"), "w").write(redact("\n".join(head)) + "\n")
    if binary:
        open(os.path.join(OUT, name), "wb").write(body)
        return
    try:
        data = json.loads(body)
        if trim:
            data = trim(data)
        text = json.dumps(data, indent=1, sort_keys=False)
    except ValueError:
        text = body.decode("utf8", "replace")
    open(os.path.join(OUT, name + ".json"), "w").write(redact(text) + "\n")


def main():
    ap = argparse.ArgumentParser()
    for a in ("web-replay", "web-project", "mobile-replay", "mobile-project", "issue", "event", "event-project", "trace"):
        ap.add_argument("--" + a, required=True)
    ap.add_argument("--org", default="sentry")
    a = ap.parse_args()
    org = a.org
    W, WP, M, MP = a.web_replay, a.web_project, a.mobile_replay, a.mobile_project
    first = lambda n: (lambda d: d[:n] if isinstance(d, list) else dict(d, data=d["data"][:n]) if isinstance(d, dict) and isinstance(d.get("data"), list) else d)
    os.makedirs(OUT, exist_ok=True)
    save("orgs-list", "/api/0/organizations/")
    save("projects-list", f"/api/0/organizations/{org}/projects/", trim=first(2))
    save("project-keys", f"/api/0/projects/{org}/{MP}/keys/", trim=scrub_keys)
    save("replays-list", f"/api/0/organizations/{org}/replays/?project=-1&statsPeriod=30d&per_page=2&query=id:{W}")
    save("replays-list-mobile", f"/api/0/organizations/{org}/replays/?project=-1&statsPeriod=30d&per_page=2&query=id:{M}")
    save("replays-list-fields", f"/api/0/organizations/{org}/replays/?project=-1&statsPeriod=30d&per_page=3&field=id&field=project_id&field=started_at&field=finished_at&field=count_segments&field=platform")
    save("replay-details", f"/api/0/organizations/{org}/replays/{M}/")
    save("recording-segments-web", f"/api/0/projects/{org}/{WP}/replays/{W}/recording-segments/")
    save("recording-segments-mobile-page1", f"/api/0/projects/{org}/{MP}/replays/{M}/recording-segments/?per_page=3")
    save("recording-segment-meta", f"/api/0/projects/{org}/{MP}/replays/{M}/recording-segments/0/")
    save("recording-segment-download-web", f"/api/0/projects/{org}/{WP}/replays/{W}/recording-segments/0/?download")
    save("replay-video-segment0.mp4", f"/api/0/projects/{org}/{MP}/replays/{M}/videos/0/", binary=True)
    save("replay-video-range", f"/api/0/projects/{org}/{MP}/replays/{M}/videos/0/", headers={"Range": "bytes=0-31"}, binary=True)
    save("replay-clicks", f"/api/0/projects/{org}/{WP}/replays/{W}/clicks/?statsPeriod=30d")
    save("replay-viewed-by", f"/api/0/projects/{org}/{MP}/replays/{M}/viewed-by/",
         trim=lambda d: {"data": {"viewed_by": [{k: v.get(k) for k in ("id", "name", "username", "email")} for v in d["data"]["viewed_by"]]}})
    save("replay-count", f"/api/0/organizations/{org}/replay-count/?project=-1&statsPeriod=30d&query=issue.id:[{a.issue}]&returnIds=true")
    save("replays-events-meta", f"/api/0/organizations/{org}/replays-events-meta/?project=-1&statsPeriod=30d&dataset=discover&field=id&field=title&field=timestamp&field=level&query=replayId:{M}")
    save("sessions-grouped", f"/api/0/organizations/{org}/sessions/?project=-1&statsPeriod=7d&interval=1d&field=sum(session)&field=count_unique(user)&field=crash_free_rate(session)&groupBy=project&groupBy=release", trim=lambda d: dict(d, groups=d["groups"][:2]))
    save("sessions-by-status", f"/api/0/organizations/{org}/sessions/?project=-1&statsPeriod=7d&interval=1d&field=sum(session)&groupBy=session.status")
    save("sessions-groupby-session-id-rejected", f"/api/0/organizations/{org}/sessions/?project=-1&statsPeriod=7d&interval=1d&field=sum(session)&groupBy=session.id")
    save("issues-list", f"/api/0/organizations/{org}/issues/?project=-1&statsPeriod=30d&limit=1&query=issue.id:{a.issue}")
    save("issue-events", f"/api/0/organizations/{org}/issues/{a.issue}/events/?per_page=1")
    save("issue-event-latest", f"/api/0/organizations/{org}/issues/{a.issue}/events/latest/",
         trim=lambda d: dict(d, entries=[dict(e, data="<trimmed>") if e["type"] == "breadcrumbs" else e for e in d["entries"]]))
    save("event-attachments", f"/api/0/projects/{org}/{a.event_project}/events/{a.event}/attachments/")
    save("eventid-lookup", f"/api/0/organizations/{org}/eventids/{a.event}/", trim=lambda d: dict(d, event="<trimmed: full event, same shape as issue-event-latest>"))
    save("events-errors", f"/api/0/organizations/{org}/events/?dataset=errors&project=-1&statsPeriod=30d&per_page=2&field=id&field=title&field=timestamp&field=trace&field=replayId&field=user.id&field=issue&sort=-timestamp")
    save("events-spans", f"/api/0/organizations/{org}/events/?dataset=spans&project=-1&statsPeriod=30d&per_page=5&field=id&field=span.op&field=span.description&field=trace&field=parent_span&field=precise.start_ts&field=precise.finish_ts&field=replay.id&field=is_transaction&query=trace:{a.trace}")
    save("events-logs", f"/api/0/organizations/{org}/events/?dataset=logs&project=-1&statsPeriod=30d&per_page=5&field=timestamp&field=message&field=severity&field=trace&field=observed_timestamp&field=timestamp_precise&query=trace:{a.trace}")
    save("trace", f"/api/0/organizations/{org}/trace/{a.trace}/?project=-1&statsPeriod=30d")
    save("trace-meta", f"/api/0/organizations/{org}/trace-meta/{a.trace}/?project=-1&statsPeriod=30d")
    save("tag-user-values", f"/api/0/organizations/{org}/tags/user/values/?project=-1&statsPeriod=30d", trim=first(3))
    save("releases-health", f"/api/0/organizations/{org}/releases/?project=-1&health=1&per_page=1&healthStatsPeriod=24h")


if __name__ == "__main__":
    main()
