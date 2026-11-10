#!/usr/bin/env python3
"""Drives the Step 5 journey on the emulator, round-robin over variants, and appends one JSON line per
run to out/runs.jsonl. Needs: emulator up with `adb root`, APKs installed, capture_server.py running.
usage: run_bench.py <serial> <runs> <variant>... """
import json, os, re, subprocess, sys, time

ADB = os.environ.get("ADB", "/opt/homebrew/share/android-commandlinetools/platform-tools/adb")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "runs.jsonl")
serial, runs, variants = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
SETTLE, IDLE, JOURNEY, GRACE, CYCLE = 8, 30, 60, 10, 15

def sh(cmd, check=False):
    r = subprocess.run([ADB, "-s", serial, "shell", cmd], capture_output=True, text=True, timeout=60)
    return r.stdout

def ticks(pid):  # utime + stime of the whole process (all threads), clock ticks (CLK_TCK = 100)
    f = sh(f"cat /proc/{pid}/stat").rsplit(")", 1)[1].split()
    return int(f[11]) + int(f[12])

def threads(pid):  # per-thread utime+stime, summed by thread name (digits folded), for attribution
    out = sh(f"for t in /proc/{pid}/task/*; do cat $t/stat; echo; done")
    acc = {}
    for line in out.splitlines():
        if ")" not in line: continue
        name = re.sub(r"\d+", "#", line[line.index("(") + 1:line.rindex(")")])
        f = line.rsplit(")", 1)[1].split()
        acc[name] = acc.get(name, 0) + int(f[11]) + int(f[12])
    return acc

def mem(pid):  # PSS and RSS in kB from smaps_rollup (read by root; the app is not involved)
    s = sh(f"cat /proc/{pid}/smaps_rollup")
    g = lambda k: int(re.search(rf"^{k}:\s+(\d+)", s, re.M).group(1))
    return {"pss_kb": g("Pss"), "rss_kb": g("Rss")}

def hwm(pid):
    return int(re.search(r"VmHWM:\s+(\d+)", sh(f"cat /proc/{pid}/status")).group(1))

def sh_host_load():  # the Mac's 1/5/15 min load averages, as `uptime` prints them
    return [float(x) for x in subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.strip("{} \n").split()]

def tap(x, y): sh(f"input tap {x} {y}")
def swipe(y0, y1): sh(f"input swipe 540 {y0} 540 {y1} 250")
def back(): sh("input keyevent 4")

def until(t):
    d = t - time.time()
    if d > 0: time.sleep(d)

def focused(pkg):
    return pkg in sh("dumpsys window | grep mCurrentFocus")

def journey(pid, t0, mems, pkg, rec):
    """4 cycles of 15 s: Home Fetch, list scroll, Detail Fetch (+ one handled error in cycle 1), back."""
    for c in range(JOURNEY // CYCLE):
        base = t0 + c * CYCLE
        if not focused(pkg):  # a tap lost under host load let BACK leave the app: bring it back, count it
            rec["refocused"] = rec.get("refocused", 0) + 1
            sh(f"am start -n {pkg}/bench.MainActivity"); time.sleep(1)
        tap(540, 400); until(base + 2)                       # Home: Fetch (2 GET + 1 POST)
        tap(540, 640); until(base + 3.5)                     # Open list
        swipe(1900, 700); until(base + 5); swipe(1900, 700); until(base + 6.5); swipe(700, 1900); until(base + 8)
        back(); until(base + 9)
        tap(540, 880); until(base + 10.5)                    # Open detail
        tap(540, 400); until(base + 12)                      # Detail: Fetch
        if c == 0: tap(540, 640)                             # Detail: Handled error (once per run)
        until(base + 13); back()
        mems.append(mem(pid)); until(base + CYCLE)

def one(variant, i):
    pkg = f"dev.ouo.bench.{variant}"
    sh(f"am force-stop {pkg}"); sh(f"pm clear {pkg}"); sh("logcat -c"); time.sleep(2)
    t_launch = time.time()
    st = sh(f"am start -W -n {pkg}/bench.MainActivity")
    total = int(re.search(r"TotalTime: (\d+)", st).group(1))
    pid = sh(f"pidof {pkg}").strip()
    until(t_launch + SETTLE)
    m = re.search(r"init_ns=(\d+)", sh("logcat -d -s ouobench:I"))
    idle_mem = mem(pid); c0 = ticks(pid); t_idle0 = time.time()
    until(t_idle0 + IDLE); c1 = ticks(pid); t_j0 = time.time()
    th0 = threads(pid); mems = [mem(pid)]
    extra = {}
    journey(pid, t_j0, mems, pkg, extra)
    c2 = ticks(pid); t_j1 = time.time(); th1 = threads(pid)
    until(t_j1 + GRACE); c3 = ticks(pid); t_end = time.time()
    rec = {"variant": variant, "run": i, "pid": pid, "start_total_ms": total, "init_ns": int(m.group(1)) if m else None,
           "t_launch": t_launch, "t_idle0": t_idle0, "t_j0": t_j0, "t_j1": t_j1, "t_end": t_end,
           "cpu_ticks": {"launch_to_idle": c0, "idle": c1 - c0, "journey": c2 - c1, "grace": c3 - c2},
           "journey_threads": {k: th1[k] - th0.get(k, 0) for k in th1 if th1[k] - th0.get(k, 0) > 0},
           "mem_idle": idle_mem, "mem_samples": mems, "vm_hwm_kb": hwm(pid),
           "refocused": extra.get("refocused", 0), "host_load_at_start": sh_host_load(),
           "alive": sh(f"pidof {pkg}").strip() == pid}
    sh(f"am force-stop {pkg}")
    with open(OUT, "a") as f: f.write(json.dumps(rec) + "\n")
    print(variant, i, total, rec["init_ns"], rec["cpu_ticks"], idle_mem, flush=True)

# usage extension: START=<first run index>; a variant written as name@index runs only that index.
start = int(os.environ.get("START", "0"))
for i in range(start, start + runs):
    for v in variants:
        if "@" in v:
            name, idx = v.split("@")
            if int(idx) == i: one(name, i)
        else:
            one(v, i)
