import sys, json, zlib, time, uuid
sys.argv = [sys.argv[0], sys.argv[1], sys.argv[2], "__none__"]
exec(open(sys.argv[0].replace("extra.py","harness.py")).read().replace("\nmain()\n","\n"))
ONLY.clear()
t=now(); rid=hexid(); eid=hexid()
revent={"type":"replay_event","replay_id":rid,"event_id":rid,"segment_id":0,"replay_type":"buffer","timestamp":t,"replay_start_timestamp":t-1,"urls":[],"error_ids":[eid],"trace_ids":[],"platform":"javascript"}
rec=b'{"segment_id":0}\n'+zlib.compress(b'[{"type":4,"timestamp":1,"data":{"href":"http://x/","width":1,"height":1}}]')
ev={"event_id":eid,"message":"step6-wire error+replay same envelope","timestamp":t,"contexts":{"replay":{"replay_id":rid}}}
send("combo-event-plus-replay_event", EP, envelope(env_header(eid), item({"type":"event"},ev), item({"type":"replay_event"},revent), item({"type":"replay_recording"},rec)), H, note="error event and replay_event in one envelope share the 'event' size limit (count 1)")
tx={"type":"transaction","event_id":hexid(),"transaction":"/x","start_timestamp":t-1,"timestamp":t,"contexts":{"trace":{"trace_id":hexid(),"span_id":hexid()[:16]}}}
send("combo-event-plus-transaction", EP, envelope(env_header(eid), item({"type":"event"},ev), item({"type":"transaction"},tx)), H)
send("auth-wrong-project-in-path-no-dsn", "/api/5/envelope/", envelope({"event_id":hexid()}, item({"type":"event"},{"message":"step6-wire wrong project no dsn","timestamp":t})), H, note="key of project 8, path /api/5/, envelope header without dsn")
send("item-session-in-error-envelope", EP, envelope(env_header(eid), item({"type":"event"},dict(ev,event_id=eid,message="step6-wire with session")), item({"type":"session"},{"sid":str(uuid.uuid4()),"init":True,"started":iso(t),"timestamp":iso(t),"status":"ok","errors":1,"attrs":{"release":"step6-wire@1.0.0"}})), H)
send("item-session-no-release", EP, envelope(env_header(), item({"type":"session"},{"sid":str(uuid.uuid4()),"init":True,"started":iso(t),"timestamp":iso(t),"status":"ok","attrs":{}})), H, note="session without attrs.release (required) is dropped async, not at the edge")
