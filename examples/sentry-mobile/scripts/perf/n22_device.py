#!/usr/bin/env python3
"""Checklist N22 on a real iPhone: #40's replay capture cost and both crash flows.

  Per-capture main-thread time (Time Profiler + os_signpost, ouo and Sentry in the same trace):
    python3 -I n22_device.py profile --device <udid> --team <TEAM> --app <build dir> --label baseline|after3 \\
        --out project/agents/ios-replay/perf/results/device [--rounds 3]
  Crash flows (session `crashed` at the crash time, native stack in Loki/rum-api, Sentry still reports):
    python3 -I n22_device.py crash --device <udid> --env <ouo-env> --app <build dir> \\
        --action native-crash|js-fatal --mode parallel|ouo --out <dir>

The app is a build.sh --target device build (endpoints on the Mac's LAN IP, through the proxy that this
script starts). `profile` writes tp/<label>/r<n>/{stalls,signposts}.json in the layout
project/agents/ios-replay/perf/report.py reads; whole-app CPU and memory per mode come from bench.py
(cells sentry, both-replay, ouo-replay) and bench_result.py, saved as cpu-<label>.json.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
IOS_PERF = os.path.join(bench.REPO, "project", "agents", "ios-replay", "perf")


def start_proxy(env, out):
    up = bench.env_ports(env)
    cmd = [sys.executable, "-I", os.path.join(HERE, "proxy.py"), "--log", os.path.join(out, "requests.jsonl"), "--lan"]
    for k, p in bench.LISTEN.items():
        cmd += ["--route", f"{k}:{p}:{up[k]}"]
    proc = subprocess.Popen(cmd, stdout=open(os.path.join(out, "proxy.log"), "w"), stderr=subprocess.STDOUT)
    time.sleep(1)
    return proc


def app_pid(t):
    procs = t.dctl("device", "info", "processes", check=False).get("result", {}).get("runningProcesses", [])
    for p in procs:
        if p.get("executable", "").rstrip("/").endswith("sentrydemo.app/sentrydemo"):
            return p["processIdentifier"]
    return None


def profile(a):
    t = bench.Device(argparse.Namespace(device=a.device, app=os.path.join(a.app, "sentrydemo.app")))
    a.out = os.path.abspath(a.out)
    base = os.path.join(a.out, "tp", a.label)
    os.makedirs(base, exist_ok=True)
    proxy = start_proxy(a.env, base)
    a.team, a.gem_home, a.dy = a.team, "/opt/homebrew/Cellar/cocoapods/1.17.0/libexec", a.dy
    try:
        xctestrun = bench.build_driver(t, a)
        t.xctestrun = xctestrun  # Device.reset primes the Local Network permission with it
        for r in range(1, a.rounds + 1):
            d = os.path.join(base, f"r{r}")
            os.makedirs(d, exist_ok=True)
            t.reset()
            t.write_doc("perf-mode.json", json.dumps({"mode": "parallel", "ouoReplay": True}))
            t.terminate()
            time.sleep(2)
            env = dict(os.environ, TEST_RUNNER_PERF_SECONDS="96", TEST_RUNNER_PERF_DY=str(a.dy))
            journey = subprocess.Popen(["xcodebuild", "test-without-building", "-xctestrun", xctestrun, "-destination", t.dest,
                                        "-only-testing:PerfJourney/PerfJourneyUITests/testJourney"],
                                       stdout=open(os.path.join(d, "xcuitest.log"), "w"), stderr=subprocess.STDOUT, env=env)
            # Device.reset ends with a priming launch: wait for the journey's own process.
            # XCUITest may launch the app twice in a row: attach once one pid has lived for 3 s.
            stale = app_pid(t)
            pid, seen, since = None, None, 0.0
            for _ in range(240):
                cur = app_pid(t)
                if cur and cur != stale and cur == seen:
                    if time.time() - since >= 3:
                        pid = cur
                        break
                elif cur and cur != stale:
                    seen, since = cur, time.time()
                time.sleep(0.5)
            if not pid:
                bench.log(f"round {r}: app never started")
                journey.wait()
                continue
            trace = os.path.join(d, "tp.trace")
            bench.log(f"round {r}: Time Profiler + os_signpost on pid {pid}, 75 s")
            # Right after an XCUITest launch xctrace may not see the pid yet ("Cannot find process"):
            # retry for up to 20 s.
            for attempt in range(10):
                r = subprocess.run(["xcrun", "xctrace", "record", "--template", "Time Profiler", "--instrument", "os_signpost",
                                    "--device", a.device, "--attach", str(pid), "--time-limit", "75s", "--output", trace],
                                   capture_output=True, text=True)
                open(os.path.join(d, "xctrace.log"), "a").write(r.stdout + r.stderr)
                if "Cannot find process" not in r.stdout + r.stderr:
                    break
                time.sleep(2)
            journey.wait()
            dsym = os.path.join(a.app, "sentrydemo.app.dSYM")
            sym = os.path.join(d, "tps.trace")
            if subprocess.run(["xcrun", "xctrace", "symbolicate", "--input", trace, "--dsym", dsym, "--output", sym],
                              capture_output=True).returncode != 0:
                sym = trace
            for schema, name in (("time-profile", "tps.xml"), ("os-signpost", "signposts.xml")):
                with open(os.path.join(d, name), "w") as f:
                    subprocess.run(["xcrun", "xctrace", "export", "--input", sym, "--xpath",
                                    f'/trace-toc/run[@number="1"]/data/table[@schema="{schema}"]'], stdout=f)
            subprocess.run([sys.executable, "-I", os.path.join(IOS_PERF, "capture_stalls.py"), os.path.join(d, "tps.xml"),
                            "--json", os.path.join(d, "stalls.json")], stdout=open(os.path.join(d, "stalls.txt"), "w"))
            subprocess.run([sys.executable, "-I", os.path.join(IOS_PERF, "signposts.py"), os.path.join(d, "signposts.xml"),
                            "--json", os.path.join(d, "signposts.json")], stdout=open(os.path.join(d, "signposts.txt"), "w"))
            for big in ("tp.trace", "tps.trace", "tps.xml"):
                p = os.path.join(d, big)
                subprocess.run(["rm", "-rf", p])
            bench.log(f"round {r}: " + open(os.path.join(d, "stalls.txt")).read().strip().replace("\n", " | ")[:300])
            t.terminate()
    finally:
        proxy.terminate()


def crash(a):
    t = bench.Device(argparse.Namespace(device=a.device, app=os.path.join(a.app, "sentrydemo.app")))
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    proxy = start_proxy(a.env, out)
    a.gem_home, a.dy = "/opt/homebrew/Cellar/cocoapods/1.17.0/libexec", 0
    try:
        t.xctestrun = bench.build_driver(t, a)
        t.reset()
        t.write_doc("perf-mode.json", json.dumps({"mode": a.mode}))
        t0 = time.time()
        bench.log(f"launch 1 ({a.mode}) with sentrydemo://action/{a.action}")
        # A cold launch with the URL: the app handles it once navigation is ready (src/deeplinks.ts).
        bench.sh(["xcrun", "devicectl", "device", "process", "launch", "--device", a.device, "--terminate-existing",
                  "--payload-url", f"sentrydemo://action/{a.action}", bench.BUNDLE], check=False)
        time.sleep(15)
        alive = app_pid(t)
        bench.log("app died" if not alive else f"app still alive (pid {alive}) after {a.action}")
        crash_t = time.time()
        # ouo's crash report as written at crash time (sdk/ios OuoCrash), before launch 2 sends it.
        r = bench.sh(["xcrun", "devicectl", "device", "copy", "from", "--device", a.device, "--domain-type", "appDataContainer",
                      "--domain-identifier", bench.BUNDLE, "--source", "Library/Application Support/ouo/crash/report.json",
                      "--destination", os.path.join(out, "report.json")], check=False)
        bench.log("ouo report on disk: " + ("copied" if r.returncode == 0 else "none"))
        bench.log("launch 2 (sends the report)")
        bench.sh(["xcrun", "devicectl", "device", "process", "launch", "--device", a.device, bench.BUNDLE], check=False)
        time.sleep(25)
        t.read_doc("perf.json", os.path.join(out, "perf.json"))
        t1 = time.time()
        reqs = [json.loads(l) for l in open(os.path.join(out, "requests.jsonl"))]
        sentry_items = [(r["t"] - t0, r.get("items")) for r in reqs if r["label"] == "sentry" and r["t"] >= crash_t]
        json.dump({"crash_window": [t0, crash_t], "after_relaunch_sentry_envelopes": sentry_items, "app_alive_after_action": bool(alive)},
                  open(os.path.join(out, "device-flow.json"), "w"), indent=1)
        bench.log(f"Sentry envelopes after relaunch: {[i for _, i in sentry_items]}")
        loki, rum = f"http://loki.{a.env}.ouo.localhost", f"http://rum-api.{a.env}.ouo.localhost"
        q = '{service_name=~".+", event_name="exception"} | ouo_exception_fatal="true"'
        url = f"{loki}/loki/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": q, "start": int(t0 * 1e9), "end": int(t1 * 1e9), "limit": 50})
        fatal = json.load(urllib.request.urlopen(url))
        json.dump(fatal, open(os.path.join(out, "loki-fatal.json"), "w"))
        lines, sid = [], None
        for r in fatal["data"]["result"]:
            s = r["stream"]
            sid = sid or s.get("session_id")
            lines.append(f"exception session={s.get('session_id')} kind={s.get('ouo_exception_kind')} type={s.get('exception_type')} "
                         f"message={s.get('exception_message')!r} crash_ts={s.get('ouo_crash_timestamp')}\n  "
                         + (s.get("exception_stacktrace") or "")[:1500].replace("\n", "\n  "))
        open(os.path.join(out, "fatal.txt"), "w").write("\n".join(lines) + "\n")
        print("\n".join(lines) or "no fatal exception in Loki")
        if sid:
            req = urllib.request.Request(f"{rum}/v1/sessions/{sid}", headers={"Authorization": f"Bearer {os.environ.get('OUO_READ_TOKEN', 'rt_dev_0000000000000000')}"})
            sess = json.load(urllib.request.urlopen(req))
            json.dump(sess, open(os.path.join(out, "session.json"), "w"))
            s = sess.get("session", sess)
            print({k: s.get(k) for k in ("session_id", "status", "state", "end_reason", "started_at", "ended_at", "error_count", "crash_count")})
    finally:
        proxy.terminate()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("profile")
    p.add_argument("--device", required=True)
    p.add_argument("--team", required=True)
    p.add_argument("--env", required=True)
    p.add_argument("--app", required=True, help="build.sh --target device output directory")
    p.add_argument("--label", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--rounds", type=int, default=3)
    p.add_argument("--dy", type=float, default=0)
    c = sub.add_parser("crash")
    c.add_argument("--device", required=True)
    c.add_argument("--env", required=True)
    c.add_argument("--app", required=True)
    c.add_argument("--action", choices=("native-crash", "js-fatal"), required=True)
    c.add_argument("--mode", choices=("parallel", "ouo"), default="parallel")
    c.add_argument("--out", required=True)
    c.add_argument("--team", required=True)
    a = ap.parse_args()
    os.environ.setdefault("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")
    profile(a) if a.cmd == "profile" else crash(a)


if __name__ == "__main__":
    main()
