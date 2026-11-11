import sys, time
sys.argv = [sys.argv[0], sys.argv[1], sys.argv[2], "__none__"]
exec(open(sys.argv[0].replace("rl.py","harness.py")).read().replace("\nmain()\n","\n"))
ONLY.clear()
for i in range(4):
    r = send(f"ratelimit-key-1-per-60s-try{i+1}", EP, error_env(f"step6-wire rl {i}")[1], H, note="project key rateLimit {window:60,count:1} set temporarily via API")
    time.sleep(1)
r = send("ratelimit-key-transaction-while-limited", EP, envelope(env_header(hexid()), item({"type":"transaction"},{"type":"transaction","event_id":hexid(),"transaction":"/rl","start_timestamp":now()-1,"timestamp":now(),"contexts":{"trace":{"trace_id":hexid(),"span_id":hexid()[:16]}}})), H)
r = send("ratelimit-key-session-while-limited", EP, envelope(env_header(), item({"type":"session"},{"sid":"6a0c2b0e-4f8e-4b4e-9e57-3f8d2a2b1c11","init":True,"started":iso(),"timestamp":iso(),"status":"ok","attrs":{"release":"step6-wire@1.0.0"}})), H)
