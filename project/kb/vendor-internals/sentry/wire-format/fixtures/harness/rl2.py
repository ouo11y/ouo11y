import sys, uuid
sys.argv = [sys.argv[0], sys.argv[1], sys.argv[2], "__none__"]
exec(open(sys.argv[0].replace("rl2.py","harness.py")).read().replace("\nmain()\n","\n"))
ONLY.clear()
eid, _ = error_env()
ev={"event_id":eid,"message":"step6-wire rl mixed","timestamp":now()}
send("ratelimit-key-mixed-event-plus-session", EP, envelope(env_header(eid), item({"type":"event"},ev), item({"type":"session"},{"sid":str(uuid.uuid4()),"init":True,"started":iso(),"timestamp":iso(),"status":"ok","attrs":{"release":"step6-wire@1.0.0"}})), H, note="error is limited, session is not: whole request answers 429, the session item is still queued")
