#!/usr/bin/env python3
"""Call ~30 read endpoints with every token in a JSON file and print a status matrix.

Usage: TOKENS_FILE=tokens.json OUT=scope-matrix.json SENTRY_URL=http://localhost:9000 \
  REPLAY=<id> PROJECT=<slug> ISSUE=<id> EVENT=<id> TRACE=<id> python3 -I scope_matrix.py
tokens.json = {"name": {"token": "...", "kind": "user|org|internal-integration", "scopes": [...]}}
Token values are never written to OUT. Read-only.
"""
import json, urllib.request, urllib.error, os
E_=os.environ; base=E_.get("SENTRY_URL","http://localhost:9000").rstrip("/")+"/api/0"
toks=json.load(open(E_["TOKENS_FILE"]))
R=E_["REPLAY"]; P=E_["PROJECT"]; I=E_["ISSUE"]; E=E_["EVENT"]; T=E_["TRACE"]
eps={
 "orgs":"/organizations/",
 "org_details":"/organizations/sentry/",
 "projects":"/organizations/sentry/projects/",
 "project_keys":f"/projects/sentry/{P}/keys/",
 "replays_list":"/organizations/sentry/replays/?statsPeriod=30d&per_page=1&field=id",
 "replay_org_details":f"/organizations/sentry/replays/{R}/",
 "replay_project_details":f"/projects/sentry/{P}/replays/{R}/",
 "segments_list":f"/projects/sentry/{P}/replays/{R}/recording-segments/?per_page=1",
 "segment_download":f"/projects/sentry/{P}/replays/{R}/recording-segments/0/?download",
 "video":f"/projects/sentry/{P}/replays/{R}/videos/0/",
 "clicks":f"/projects/sentry/{P}/replays/{R}/clicks/",
 "viewed_by":f"/projects/sentry/{P}/replays/{R}/viewed-by/",
 "replay_count":f"/organizations/sentry/replay-count/?query=issue.id:[{I}]&statsPeriod=30d",
 "replay_selectors":"/organizations/sentry/replay-selectors/?statsPeriod=30d",
 "replay_summary":f"/projects/sentry/{P}/replays/{R}/summarize/",
 "sessions":"/organizations/sentry/sessions/?field=sum(session)&statsPeriod=30d&interval=1d",
 "issues":"/organizations/sentry/issues/?statsPeriod=30d&limit=1",
 "issue_details":f"/organizations/sentry/issues/{I}/",
 "issue_events":f"/organizations/sentry/issues/{I}/events/?per_page=1",
 "issue_latest":f"/organizations/sentry/issues/{I}/events/latest/",
 "event_details":f"/projects/sentry/{P}/events/{E}/",
 "event_attachments":f"/projects/sentry/{P}/events/{E}/attachments/",
 "events_errors":"/organizations/sentry/events/?dataset=errors&field=id&statsPeriod=30d&per_page=1",
 "events_spans":"/organizations/sentry/events/?dataset=spans&field=id&statsPeriod=30d&per_page=1",
 "events_logs":"/organizations/sentry/events/?dataset=ourlogs&field=message&statsPeriod=30d&per_page=1",
 "trace":f"/organizations/sentry/trace/{T}/?statsPeriod=30d",
 "trace_meta":f"/organizations/sentry/trace-meta/{T}/?statsPeriod=30d",
 "eventid_lookup":f"/organizations/sentry/eventids/{E}/",
 "org_tag_user_values":"/organizations/sentry/tags/user/values/?statsPeriod=30d",
 "releases":"/organizations/sentry/releases/?per_page=1",
 "project_users":f"/projects/sentry/{P}/users/",
}
res={}
for tn,t in toks.items():
    res[tn]={}
    for en,p in eps.items():
        req=urllib.request.Request(base+p,headers={"Authorization":"Bearer "+t["token"]})
        try:
            with urllib.request.urlopen(req,timeout=30) as r: res[tn][en]=r.status; r.read()
        except urllib.error.HTTPError as e:
            body=e.read()[:120].decode("utf8","replace"); res[tn][en]=f"{e.code}"; res[tn][en+"_body"]=body
json.dump({"tokens":{k:{"kind":v["kind"],"scopes":v["scopes"]} for k,v in toks.items()},"endpoints":eps,"results":res},open(E_["OUT"],"w"),indent=1)
names=list(toks)
print("endpoint".ljust(24)+" ".join(n[:10].ljust(10) for n in names))
for en in eps: print(en.ljust(24)+" ".join(str(res[n][en]).ljust(10) for n in names))
