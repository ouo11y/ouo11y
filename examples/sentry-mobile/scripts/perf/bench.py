#!/usr/bin/env python3
"""Device-cost benchmark, ouo SDK vs Sentry SDK, per tier (method and fairness rules: docs/benchmarks.md).

    python3 -I bench.py --env <ouo-env> --app <sentrydemo.app> --out <dir> [--target sim|device]
                        [--device <udid>] [--team <TEAM_ID>] [--runs 10] [--cells "none sentry-T1 ..."]
                        [--seconds 95] [--soak-minutes 30] [--no-soak] [--no-offline] [--dy 0]
                        [--energy-runs 0] [--sink]

The app must be a Release build with OUO_PERF=1 whose SDK endpoints point at this proxy (build.sh
does both). Per run: reset the app (simulator: terminate and wipe its container; device: reinstall),
write Documents/perf-mode.json (SDK and tier for this launch), start the recorder (simulator:
sample.py; device: xctrace Activity Monitor), run the XCUITest journey (real taps), then collect
perf.json, the app container's file sizes and the host times of the run. Cells are interleaved
round-robin and rotated each round. After the rounds: one soak run per soak cell (journey looped
for --soak-minutes), and one offline run per replay cell (proxy refuses SDK traffic) followed by a
recover run (relaunch online, idle) that counts what the SDK sent from its offline buffer.

Writes <out>/runs/<kind>/<cell>/run<n>/ and <out>/meta.json; analyze.py turns them into
result.json. --sink answers SDK requests in the proxy instead of forwarding them (CI, no Docker).
"""
import argparse
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(APP_DIR, "..", ".."))
BUNDLE = "dev.ouo.sentrydemo"
DEFAULT_SIM = "A99B6BF8-6975-4407-9B59-D38066523B15"

# Proxy listen ports (baked into the app by build.sh) and the env's published ingest ports
# (deploy/envs/README.md: block n -> 20000 + 10 n + offset; main 4318/4319/4320/8082).
LISTEN = {"otlp": 4718, "replay": 4719, "sentry": 4720, "backend": 4781}
OFFSET = {"otlp": 0, "replay": 1, "sentry": 2, "backend": 3}

# Cell -> Documents/perf-mode.json (src/rollout.ts perfOverride). `tier` sets the SDK options of
# docs/benchmarks.md section 1 (src/sentry.ts, src/ouo.ts). ouo has no T1 (fetch tracing cannot be
# switched off): its smallest cell is T2.
CELLS = {
    "none": {"mode": "none"},
    "sentry-T1": {"mode": "sentry", "tier": "T1"},
    "sentry-T2": {"mode": "sentry", "tier": "T2"},
    "sentry-T3": {"mode": "sentry", "tier": "T3"},
    "sentry-T4": {"mode": "sentry", "tier": "T4"},
    "ouo-T2": {"mode": "ouo", "tier": "T2", "ouoReplay": False},
    "ouo-T3": {"mode": "ouo", "tier": "T3", "ouoReplay": True},
    "ouo-T4": {"mode": "ouo", "tier": "T4", "ouoReplay": True},
    # The #25 modes with the demo's own SDK options (no tier): N22 and the ios-replay report use them.
    "sentry": {"mode": "sentry"},
    "both": {"mode": "parallel"},
    "both-replay": {"mode": "parallel", "ouoReplay": True},
    "ouo-replay": {"mode": "ouo"},
}
DEFAULT_CELLS = ["none", "sentry-T1", "sentry-T2", "ouo-T2", "sentry-T3", "ouo-T3", "sentry-T4", "ouo-T4"]
SOAK_CELLS = ["none", "sentry-T3", "ouo-T3"]
OFFLINE_CELLS = ["sentry-T3", "ouo-T3"]


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} [bench] {msg}", flush=True)


def sh(cmd, check=True, capture=True, **kw):
    r = subprocess.run(cmd, capture_output=capture, text=True, **kw)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} -> {r.returncode}\n{r.stdout}\n{r.stderr}")
    return r


def env_ports(env):
    if env == "main":
        return {"otlp": 4318, "replay": 4319, "sentry": 4320, "backend": 8082}
    state = os.path.expanduser(os.environ.get("OUO_ENV_STATE", "~/.local/state/ouo-env"))
    block = json.load(open(os.path.join(state, f"{env}.json")))["block"]
    return {k: 20000 + 10 * block + o for k, o in OFFSET.items()}


def lan_ip():
    for iface in ("en0", "en1"):
        r = sh(["ipconfig", "getifaddr", iface], check=False)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    return None


# ---------------------------------------------------------------------------------------------
# Targets


class Sim:
    kind = "sim"

    def __init__(self, a):
        self.udid = a.device or os.environ.get("SIM_UDID", DEFAULT_SIM)
        self.app = a.app
        self.dest = f"id={self.udid}"

    def info(self):
        r = json.loads(sh(["xcrun", "simctl", "list", "devices", "-j"]).stdout)
        for rt, devs in r["devices"].items():
            for d in devs:
                if d["udid"] == self.udid:
                    return {"target": "simulator", "udid": self.udid, "name": d["name"], "model": (d.get("deviceTypeIdentifier") or "").split(".")[-1].replace("-", " "),
                            "os": rt.split(".")[-1].replace("iOS-", "iOS ").replace("-", "."), "host": platform.node(), "host_machine": platform.machine(),
                            "host_os": platform.mac_ver()[0]}
        return {"target": "simulator", "udid": self.udid}

    def install(self):
        sh(["xcrun", "simctl", "install", self.udid, self.app])

    def container(self):
        return sh(["xcrun", "simctl", "get_app_container", self.udid, BUNDLE, "data"]).stdout.strip()

    def terminate(self):
        sh(["xcrun", "simctl", "terminate", self.udid, BUNDLE], check=False)

    def reset(self):
        self.terminate()
        time.sleep(2)
        data = self.container()
        for sub in ("Library", "tmp", "Documents"):
            p = os.path.join(data, sub)
            if os.path.isdir(p):
                for name in os.listdir(p):
                    if sub == "Library" and name == "Preferences":
                        # Preferences hold the SDKs' UserDefaults (seq stores, Sentry install id) as
                        # well: wipe the files but keep the folder cfprefsd watches.
                        for f in os.listdir(os.path.join(p, name)):
                            os.remove(os.path.join(p, name, f))
                        continue
                    q = os.path.join(p, name)
                    shutil.rmtree(q) if os.path.isdir(q) and not os.path.islink(q) else os.remove(q)
        # cfprefsd caches UserDefaults per app: drop its cache or the next launch reads the old values.
        sh(["xcrun", "simctl", "spawn", self.udid, "defaults", "delete", BUNDLE], check=False)

    def write_doc(self, name, text):
        d = os.path.join(self.container(), "Documents")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "w") as f:
            f.write(text)

    def read_doc(self, name, dest):
        src = os.path.join(self.container(), "Documents", name)
        if os.path.exists(src):
            shutil.copy(src, dest)
            return True
        return False

    def files(self):
        root = self.container()
        out = []
        for dp, _, fs in os.walk(root):
            for f in fs:
                p = os.path.join(dp, f)
                try:
                    out.append({"path": os.path.relpath(p, root), "size": os.lstat(p).st_size})
                except OSError:
                    pass
        return out

    def start_recorder(self, run_dir, seconds):
        return subprocess.Popen(
            [sys.executable, "-I", os.path.join(HERE, "sample.py"), "--exe", "sentrydemo.app/sentrydemo",
             "--out", os.path.join(run_dir, "samples.json"), "--seconds", str(seconds)],
            stdout=open(os.path.join(run_dir, "sample.log"), "w"), stderr=subprocess.STDOUT)

    def stop_recorder(self, proc, run_dir):
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()


class Device:
    """A real iPhone over USB (devicectl + xctrace). Every run reinstalls the app: the cleanest
    cold state devicectl offers (it cannot delete files inside a container)."""
    kind = "device"

    def __init__(self, a):
        if not a.device:
            raise SystemExit("--device <udid> is required for --target device")
        self.udid = a.device
        self.app = a.app
        self.dest = f"id={self.udid}"
        self.energy = False

    def dctl(self, *args, check=True):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as t:
            path = t.name
        r = sh(["xcrun", "devicectl", *args, "--device", self.udid, "--quiet", "--json-output", path], check=check)
        try:
            return json.load(open(path)) if os.path.getsize(path) else {}
        finally:
            os.remove(path)

    def info(self):
        d = self.dctl("device", "info", "details").get("result", {})
        dev, hw = d.get("deviceProperties", {}), d.get("hardwareProperties", {})
        return {"target": "device", "udid": self.udid, "name": dev.get("name"), "model": hw.get("marketingName") or hw.get("productType"),
                "product_type": hw.get("productType"), "os": dev.get("osVersionNumber"), "os_build": dev.get("osBuildUpdate"),
                "host": platform.node(), "host_os": platform.mac_ver()[0]}

    def install(self):
        sh(["xcrun", "devicectl", "device", "install", "app", "--device", self.udid, self.app])

    def terminate(self):
        procs = self.dctl("device", "info", "processes", check=False).get("result", {}).get("runningProcesses", [])
        for p in procs:
            if p.get("executable", "").rstrip("/").endswith("sentrydemo.app/sentrydemo"):
                sh(["xcrun", "devicectl", "device", "process", "signal", "--device", self.udid, "--pid",
                    str(p["processIdentifier"]), "--signal", "SIGKILL"], check=False)

    def reset(self):
        self.terminate()
        time.sleep(1)
        sh(["xcrun", "devicectl", "device", "uninstall", "app", "--device", self.udid, BUNDLE], check=False)
        self.install()

    def write_doc(self, name, text):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, name)
            open(p, "w").write(text)
            sh(["xcrun", "devicectl", "device", "copy", "to", "--device", self.udid, "--domain-type", "appDataContainer",
                "--domain-identifier", BUNDLE, "--source", p, "--destination", f"Documents/{name}"])

    def read_doc(self, name, dest):
        r = sh(["xcrun", "devicectl", "device", "copy", "from", "--device", self.udid, "--domain-type", "appDataContainer",
                "--domain-identifier", BUNDLE, "--source", f"Documents/{name}", "--destination", dest], check=False)
        return r.returncode == 0 and os.path.exists(dest)

    def files(self):
        r = self.dctl("device", "info", "files", "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE, check=False)
        out = []
        for f in r.get("result", {}).get("files", []):
            if f.get("fileType", "file") == "file" or "size" in f:
                out.append({"path": f.get("relativePath") or f.get("name"), "size": int(f.get("size") or 0)})
        return out

    def start_recorder(self, run_dir, seconds):
        # Activity Monitor for every process (the app is launched by XCUITest after recording starts,
        # so --attach is not possible); analyze.py keeps the sentrydemo rows. Energy runs use the
        # Power Profiler template instead (one xctrace recording per device at a time).
        template = "Power Profiler" if self.energy else "Activity Monitor"
        trace = os.path.join(run_dir, "rec.trace")
        return subprocess.Popen(
            ["xcrun", "xctrace", "record", "--template", template, "--device", self.udid, "--all-processes",
             "--time-limit", f"{int(seconds) + 5}s", "--output", trace],
            stdout=open(os.path.join(run_dir, "xctrace.log"), "w"), stderr=subprocess.STDOUT)

    def stop_recorder(self, proc, run_dir):
        try:
            proc.wait(timeout=180)
        except subprocess.TimeoutExpired:
            proc.send_signal(signal.SIGINT)
            proc.wait(timeout=120)
        trace = os.path.join(run_dir, "rec.trace")
        if not os.path.exists(trace):
            return
        toc = sh(["xcrun", "xctrace", "export", "--input", trace, "--toc"], check=False).stdout
        open(os.path.join(run_dir, "toc.xml"), "w").write(toc)
        for schema in ("activity-monitor-process-live", "sysmon-process", "activity-monitor-process-ledger",
                       "power-profiler-process", "SystemPowerLevel", "hitches"):
            if f'schema="{schema}"' in toc:
                sh(["xcrun", "xctrace", "export", "--input", trace, "--output", os.path.join(run_dir, f"{schema}.xml"),
                    "--xpath", f'/trace-toc/run[@number="1"]/data/table[@schema="{schema}"]'], check=False)
        shutil.rmtree(trace, ignore_errors=True)


# ---------------------------------------------------------------------------------------------


def build_driver(t, a):
    build = os.path.join(HERE, "driver", "build", t.kind)
    products = os.path.join(build, "dd", "Build", "Products")
    if not os.path.isdir(products):
        log("build the XCUITest driver")
        env = dict(os.environ, GEM_HOME=a.gem_home)
        if a.team:
            env["TEAM_ID"] = a.team
        out = sh(["/opt/homebrew/opt/ruby/bin/ruby", os.path.join(HERE, "make-driver.rb")], env=env).stdout.strip()
        os.makedirs(build, exist_ok=True)
        cmd = ["xcodebuild", "build-for-testing", "-project", out, "-scheme", "PerfJourney", "-destination", t.dest,
               "-derivedDataPath", os.path.join(build, "dd")]
        if t.kind == "device":
            cmd.append("-allowProvisioningUpdates")
        with open(os.path.join(build, "build.log"), "w") as f:
            if subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT).returncode:
                raise SystemExit(f"driver build failed: {build}/build.log")
    return sorted(p for p in os.listdir(products) if p.endswith(".xctestrun"))[0] and os.path.join(
        products, sorted(p for p in os.listdir(products) if p.endswith(".xctestrun"))[0])


def run_one(t, a, xctestrun, kind, cell, n, seconds, journey="taps", reset=True, offline=False):
    d = os.path.join(a.out, "runs", kind, cell, f"run{n}")
    os.makedirs(d, exist_ok=True)
    if reset:
        t.reset()
    else:
        t.terminate()
        time.sleep(2)
    t.write_doc("perf-mode.json", json.dumps(CELLS[cell]))
    flag = os.path.join(a.out, "offline.flag")
    if offline:
        open(flag, "w").close()
    time.sleep(3)  # let the host and device settle after the reset
    rec_t0 = time.time()
    rec = t.start_recorder(d, seconds)
    time.sleep(1 if t.kind == "sim" else 4)  # xctrace needs a few seconds before it records
    t0 = time.time()
    env = dict(os.environ, TEST_RUNNER_PERF_SECONDS=str(int(seconds) + 1), TEST_RUNNER_PERF_JOURNEY=journey,
               TEST_RUNNER_PERF_DY=str(a.dy))
    with open(os.path.join(d, "xcuitest.log"), "w") as f:
        rc = subprocess.run(["xcodebuild", "test-without-building", "-xctestrun", xctestrun, "-destination", t.dest,
                             "-only-testing:PerfJourney/PerfJourneyUITests/testJourney"], stdout=f, stderr=subprocess.STDOUT, env=env).returncode
    t1 = time.time()
    if rc:
        log(f"  xcuitest exit {rc} ({d}/xcuitest.log)")
    t.stop_recorder(rec, d)
    if offline and os.path.exists(flag):
        os.remove(flag)
    got = t.read_doc("perf.json", os.path.join(d, "perf.json"))
    t.terminate()
    time.sleep(1)
    json.dump({"files": t.files()}, open(os.path.join(d, "disk.json"), "w"))
    steps = [l for l in open(os.path.join(d, "xcuitest.log"), errors="replace") if l.startswith("PERF ")]
    open(os.path.join(d, "steps.log"), "w").writelines(steps)
    meta = {"kind": kind, "cell": cell, "round": n, "seconds": seconds, "journey": journey, "host_t0": t0, "host_t1": t1,
            "xcuitest_rc": rc, "recorder_t0": rec_t0, "perf_json": got, "offline": offline, "target": t.kind,
            "energy": getattr(t, "energy", False)}
    json.dump(meta, open(os.path.join(d, "meta.json"), "w"))
    log(f"  {kind} {cell} run{n}: {sum(1 for s in steps if s.startswith('PERF step'))} steps, perf.json {'ok' if got else 'MISSING'}")


def versions():
    def pkg(name):
        try:
            return json.load(open(os.path.join(APP_DIR, "node_modules", name, "package.json")))["version"]
        except OSError:
            return None
    v = {k: pkg(k) for k in ("@sentry/react-native", "@sentry/core", "@ouo11y/react-native", "react-native", "expo", "hermes-compiler")}
    lock = os.path.join(APP_DIR, "ios", "Podfile.lock")
    if os.path.exists(lock):
        for line in open(lock):
            m = re.match(r"^  - (RNSentry|OuoReplay|OuoReplayCore|hermes-engine) \(([\d.]+)\):?$", line.rstrip())
            if m:
                v["pod " + m.group(1)] = m.group(2)
    # sentry-cocoa ships as a prebuilt xcframework, one folder per version.
    xcf = os.path.join(APP_DIR, "ios", "Pods", "sentry-xcframeworks")
    if os.path.isdir(xcf):
        v["sentry-cocoa"] = " ".join(sorted(os.listdir(xcf)))
    v["xcode"] = sh(["xcodebuild", "-version"], check=False).stdout.split("\n")[0]
    v["git_sha"] = sh(["git", "-C", REPO, "rev-parse", "HEAD"], check=False).stdout.strip()
    v["git_dirty"] = bool(sh(["git", "-C", REPO, "status", "--porcelain", "--", "examples/sentry-mobile", "sdk"], check=False).stdout.strip())
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True, help="ouo-env name whose ingest ports the proxy forwards to, or `none`")
    ap.add_argument("--app", required=True, help="path to sentrydemo.app (build.sh output)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target", choices=("sim", "device"), default="sim")
    ap.add_argument("--device")
    ap.add_argument("--team", help="Apple team ID for signing the driver (device)")
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--cells", default=" ".join(DEFAULT_CELLS))
    ap.add_argument("--seconds", type=float, default=95)
    ap.add_argument("--soak-minutes", type=float, default=30)
    ap.add_argument("--no-soak", action="store_true")
    ap.add_argument("--no-offline", action="store_true")
    ap.add_argument("--energy-runs", type=int, default=0, help="device: extra rounds recorded with Power Profiler")
    ap.add_argument("--dy", type=float, default=0, help="vertical tap offset in points (driver PERF_DY)")
    ap.add_argument("--sink", action="store_true", help="proxy answers SDK requests itself (no stack); with --env none")
    ap.add_argument("--backend-port", type=int, help="demo backend port when there is no env (--env none --sink)")
    ap.add_argument("--gem-home", default="/opt/homebrew/Cellar/cocoapods/1.17.0/libexec")
    a = ap.parse_args()
    a.out = os.path.abspath(a.out)
    a.app = os.path.abspath(a.app)
    os.makedirs(a.out, exist_ok=True)
    os.environ.setdefault("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")
    cells = a.cells.split()
    for c in cells:
        if c not in CELLS:
            raise SystemExit(f"unknown cell {c}; known: {' '.join(CELLS)}")

    t = Sim(a) if a.target == "sim" else Device(a)
    if a.env == "none":
        if not (a.sink and a.backend_port):
            raise SystemExit("--env none needs --sink and --backend-port")
        up = {"otlp": 9, "replay": 9, "sentry": 9, "backend": a.backend_port}
    else:
        up = env_ports(a.env)
    routes = [f"{k}:{LISTEN[k]}:{up[k]}" for k in LISTEN]
    proxy_cmd = [sys.executable, "-I", os.path.join(HERE, "proxy.py"), "--log", os.path.join(a.out, "requests.jsonl"),
                 "--offline-flag", os.path.join(a.out, "offline.flag")] + sum((["--route", r] for r in routes), [])
    if a.target == "device":
        proxy_cmd.append("--lan")
    if a.sink:
        proxy_cmd.append("--sink")
    proxy = subprocess.Popen(proxy_cmd, stdout=open(os.path.join(a.out, "proxy.log"), "w"), stderr=subprocess.STDOUT)
    try:
        time.sleep(1)
        if proxy.poll() is not None:
            raise SystemExit(f"proxy did not start: {open(os.path.join(a.out, 'proxy.log')).read()}")
        xctestrun = build_driver(t, a)
        meta = {"started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "env": a.env, "routes": routes, "sink": a.sink,
                "device": t.info(), "versions": versions(), "cells": cells, "runs": a.runs, "seconds": a.seconds,
                "soak_minutes": None if a.no_soak else a.soak_minutes, "lan_ip": lan_ip() if a.target == "device" else None,
                "configs": {c: CELLS[c] for c in cells}}
        json.dump(meta, open(os.path.join(a.out, "meta.json"), "w"), indent=1)
        log(f"{t.kind} {meta['device'].get('name')} {meta['device'].get('os')}; cells {' '.join(cells)}; {a.runs} rounds")
        if t.kind == "sim":
            t.install()
        for r in range(1, a.runs + 1):
            order = cells[(r - 1) % len(cells):] + cells[: (r - 1) % len(cells)]
            log(f"round {r}/{a.runs}")
            for c in order:
                run_one(t, a, xctestrun, "main", c, r, a.seconds)
        if t.kind == "device" and a.energy_runs:
            t.energy = True
            for r in range(1, a.energy_runs + 1):
                order = cells[(r - 1) % len(cells):] + cells[: (r - 1) % len(cells)]
                log(f"energy round {r}/{a.energy_runs}")
                for c in order:
                    run_one(t, a, xctestrun, "energy", c, r, a.seconds)
            t.energy = False
        if not a.no_offline:
            for c in [c for c in OFFLINE_CELLS if c in cells]:
                log(f"offline {c}")
                run_one(t, a, xctestrun, "offline", c, 1, a.seconds, offline=True)
                run_one(t, a, xctestrun, "recover", c, 1, 40, journey="idle", reset=False)
        if not a.no_soak:
            for c in [c for c in SOAK_CELLS if c in cells]:
                log(f"soak {c} {a.soak_minutes} min")
                run_one(t, a, xctestrun, "soak", c, 1, a.soak_minutes * 60, journey="loop")
        meta["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        meta["device_end"] = t.info()
        json.dump(meta, open(os.path.join(a.out, "meta.json"), "w"), indent=1)
        log(f"done: {a.out}")
    finally:
        proxy.send_signal(signal.SIGINT)
        try:
            proxy.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proxy.kill()


if __name__ == "__main__":
    main()
