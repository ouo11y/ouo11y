#!/usr/bin/env python3
"""Sample one simulator app process from the host, the counters Instruments' Activity Monitor uses.

    python3 -I sample.py --exe sentrydemo.app/sentrydemo --out run.json --seconds 120 [--interval 0.5]

Waits for a process whose executable path ends with --exe and that started after this script, then
reads proc_pid_rusage (RUSAGE_INFO_V6) every --interval seconds for --seconds after the process
start: CPU time (user + system), phys_footprint (the "Memory" number in Xcode's gauge and in
jetsam decisions), lifetime peak footprint, energy (nJ, as billed by the host kernel), wakeups,
plus the process start time (proc_pidinfo PROC_PIDTBSDINFO, microseconds) so app start can be
computed from the app's own first-frame wall-clock time. Simulator apps are host processes, so
this reads the real kernel counters for the app; it does not include work done for the app by
other processes (backboardd, the render server, the simulator's network stack).
"""
import argparse
import ctypes
import ctypes.util
import json
import os
import subprocess
import sys
import time

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)

RUSAGE_INFO_V6 = 6
PROC_PIDTBSDINFO = 3
PROC_PIDPATHINFO_MAXSIZE = 4096


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


tb = Timebase()
libc.mach_timebase_info(ctypes.byref(tb))
TICK_NS = tb.numer / tb.denom

# rusage_info_v6: 16-byte uuid then uint64 fields (sys/resource.h). Indices into the uint64 array.
F = {
    "user": 0, "system": 1, "pkg_idle_wkups": 2, "interrupt_wkups": 3, "pageins": 4,
    "resident": 6, "phys_footprint": 7, "diskio_read": 16, "diskio_written": 17,
    "lifetime_max_footprint": 28, "instructions": 29, "cycles": 30, "billed_energy": 31,
    "interval_max_footprint": 33, "runnable_time": 34, "energy_nj": 40,
}


class RUsage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16), ("v", ctypes.c_uint64 * 64)]


def rusage(pid):
    r = RUsage()
    if libproc.proc_pid_rusage(pid, RUSAGE_INFO_V6, ctypes.byref(r)) != 0:
        return None
    v = r.v
    return {
        "cpu_ns": (v[F["user"]] + v[F["system"]]) * TICK_NS,
        "user_ns": v[F["user"]] * TICK_NS,
        "system_ns": v[F["system"]] * TICK_NS,
        "footprint": v[F["phys_footprint"]],
        "resident": v[F["resident"]],
        "lifetime_max_footprint": v[F["lifetime_max_footprint"]],
        "energy_nj": v[F["energy_nj"]],
        "wakeups": v[F["pkg_idle_wkups"]] + v[F["interrupt_wkups"]],
        "instructions": v[F["instructions"]],
        "cycles": v[F["cycles"]],
        "diskio_written": v[F["diskio_written"]],
    }


def start_time(pid):
    buf = ctypes.create_string_buffer(256)
    n = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, ctypes.c_uint64(0), buf, 256)
    if n < 136:
        return None
    sec = int.from_bytes(buf.raw[120:128], "little")
    usec = int.from_bytes(buf.raw[128:136], "little")
    return sec + usec / 1e6


def path_of(pid):
    buf = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    if libproc.proc_pidpath(pid, buf, PROC_PIDPATHINFO_MAXSIZE) <= 0:
        return ""
    return buf.value.decode(errors="replace")


def find_pid(exe, after):
    out = subprocess.run(["pgrep", "-f", exe], capture_output=True, text=True).stdout.split()
    for p in out:
        pid = int(p)
        if path_of(pid).endswith(exe):
            st = start_time(pid)
            if st and st >= after:
                return pid, st
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=float, default=120)
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--wait", type=float, default=120, help="give up if no process appears")
    a = ap.parse_args()

    t0 = time.time()
    pid = st = None
    while time.time() - t0 < a.wait:
        pid, st = find_pid(a.exe, t0 - 0.5)
        if pid:
            break
        time.sleep(0.05)
    if not pid:
        print("no process", file=sys.stderr)
        sys.exit(1)
    samples = []
    failures = 0
    end = st + a.seconds
    while True:
        now = time.time()
        r = rusage(pid)
        if r is None:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break  # process exited
            failures += 1  # transient read failure: skip this sample
            time.sleep(0.05)
            continue
        r["t"] = now - st
        samples.append(r)
        if now >= end:
            break
        time.sleep(max(0.0, min(a.interval, end - time.time())))
    with open(a.out, "w") as f:
        json.dump({"pid": pid, "process_start": st, "seconds": a.seconds, "read_failures": failures, "samples": samples}, f)
    print(f"pid {pid} samples {len(samples)} last t {samples[-1]['t']:.1f}s read failures {failures}" if samples else "no samples")


if __name__ == "__main__":
    main()
