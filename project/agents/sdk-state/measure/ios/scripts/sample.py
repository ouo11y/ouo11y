#!/usr/bin/env python3
"""Samples one simulator app process (a host process) by PID with proc_pid_rusage (RUSAGE_INFO_V6):
CPU time (user+system), phys_footprint, lifetime max footprint. Adapted from
examples/sentry-mobile/scripts/perf/sample.py (same counters), taking the PID simctl launch prints.
    python3 -I sample.py --pid N --out run.json --seconds 90 [--interval 0.5]"""
import argparse, ctypes, ctypes.util, json, os, time

libc = ctypes.CDLL(ctypes.util.find_library("c"))
libproc = ctypes.CDLL("/usr/lib/libproc.dylib")


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


tb = Timebase()
libc.mach_timebase_info(ctypes.byref(tb))
TICK_NS = tb.numer / tb.denom


class RUsage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16), ("v", ctypes.c_uint64 * 64)]


def rusage(pid):
    r = RUsage()
    if libproc.proc_pid_rusage(pid, 6, ctypes.byref(r)) != 0:
        return None
    v = r.v
    return {"cpu_ns": (v[0] + v[1]) * TICK_NS, "footprint": v[7], "resident": v[6], "lifetime_max_footprint": v[28]}


def start_time(pid):
    buf = ctypes.create_string_buffer(256)
    n = libproc.proc_pidinfo(pid, 3, ctypes.c_uint64(0), buf, 256)
    if n < 136:
        return None
    return int.from_bytes(buf.raw[120:128], "little") + int.from_bytes(buf.raw[128:136], "little") / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=float, default=90)
    ap.add_argument("--interval", type=float, default=0.5)
    a = ap.parse_args()
    st = start_time(a.pid) or time.time()
    samples = []
    while True:
        now = time.time()
        r = rusage(a.pid)
        if r is None:
            try:
                os.kill(a.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
            continue
        r["t"] = now - st
        samples.append(r)
        if now - st >= a.seconds:
            break
        time.sleep(a.interval)
    with open(a.out, "w") as f:
        json.dump({"pid": a.pid, "process_start": st, "samples": samples}, f)


if __name__ == "__main__":
    main()
