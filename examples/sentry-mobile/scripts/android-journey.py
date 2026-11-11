#!/usr/bin/env python3
"""Unattended Sentry SDK journey on an Android emulator, with real taps (adb input).

    python3 -I scripts/android-journey.py --serial emulator-5580 [--phases all|replay] [--replay-seconds 120]

A Release build is not debuggable, so the iOS file mailbox (scripts/journey.sh) cannot be written
(`run-as` fails), and a deep link pauses the activity, which React Native reports as a background
(project/kb-archive/android-setup.md). This driver finds the buttons by their testID (React Native
exposes it as the accessibility resource-id in `uiautomator dump`), scrolls to them and taps them, so
the replay also records real touches and `ui.tap` breadcrumbs.

Phases (`all`): launch, nav (product, cart, back), network, shop (one round), errors, replay wait,
background (HOME for --bg-seconds, relaunch: session `exited` + new session), js-fatal (relaunch),
native crash (relaunch), end (force-stop). `replay`: launch, then --replay-seconds of a fixed tap
loop over screens and actions, then HOME (flushes the last segment) and force-stop. Written for the
Step 6 wire captures (project/kb/vendor-internals/sentry/mobile-sdks/wire-capture.md).
"""
import argparse
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PKG = "dev.ouo.sentrydemo"
ADB = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb"


class Device:
    def __init__(self, serial):
        self.serial = serial

    def sh(self, *cmd, check=True):
        return subprocess.run([ADB, "-s", self.serial, "shell", *cmd], capture_output=True, text=True, check=check).stdout

    def log(self, msg):
        print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "[android-journey]", msg, flush=True)

    def wait(self, s, why=""):
        self.log(f"  wait {s}s {why}")
        time.sleep(s)

    def nodes(self):
        self.sh("uiautomator", "dump", "/sdcard/ui.xml", check=False)
        xml = self.sh("cat", "/sdcard/ui.xml", check=False)
        xml = xml[xml.find("<?xml"):]
        try:
            root = ET.fromstring(xml)
        except ET.ParseError:
            return []
        out = []
        for n in root.iter("node"):
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
            if m:
                x1, y1, x2, y2 = map(int, m.groups())
                out.append((n.get("resource-id", ""), n.get("text", ""), (x1 + x2) // 2, (y1 + y2) // 2, y2 - y1))
        return out

    def tap_id(self, rid, tries=8):
        for i in range(tries):
            for res, text, x, y, h in self.nodes():
                if res == rid and 300 < y < 2200 and h > 20:
                    self.log(f"tap {rid} at {x},{y}")
                    self.sh("input", "tap", str(x), str(y))
                    return True
            # scroll down first, then up
            if i < tries // 2:
                self.sh("input", "swipe", "540", "1800", "540", "900", "400")
            else:
                self.sh("input", "swipe", "540", "900", "540", "1800", "400")
            time.sleep(0.8)
        self.log(f"!! {rid} not found")
        return False

    def back(self):
        self.log("BACK")
        self.sh("input", "keyevent", "KEYCODE_BACK")

    def home(self):
        self.log("HOME")
        self.sh("input", "keyevent", "KEYCODE_HOME")

    def launch(self):
        self.log(f"launch {PKG}")
        self.sh("monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1", check=False)

    def stop(self):
        self.log(f"force-stop {PKG}")
        self.sh("am", "force-stop", PKG)

    def top(self):
        for _ in range(4):
            self.sh("input", "swipe", "540", "700", "540", "2000", "200")


def full(d, a):
    d.stop(); d.wait(1); d.launch(); d.wait(8, "app start, session init, first screen")
    d.log("== phase nav")
    d.tap_id("product-p-1001"); d.wait(3)
    d.tap_id("btn-Go to cart"); d.wait(3)
    d.tap_id("btn-Back to products"); d.wait(3)
    d.log("== phase network")
    for name, w in (("fetch-ok", 2), ("fetch-500", 2), ("fetch-slow", 5), ("xhr-cart", 2)):
        d.tap_id(f"action-{name}"); d.wait(w)
    d.log("== phase shop")
    for name in ("browse-catalog", "search", "checkout", "checkout-fail"):
        d.tap_id(f"action-{name}"); d.wait(3)
    d.log("== phase errors")
    for name, w in (("handled-error", 2), ("message", 2), ("unhandled-rejection", 2), ("feedback", 3)):
        d.tap_id(f"action-{name}"); d.wait(w)
    d.wait(a.replay_wait, "replay segments")
    d.log("== phase background")
    d.home(); d.wait(a.bg_seconds, "> 30 s in background")
    d.launch(); d.wait(8, "previous session exited, new session init")
    d.top(); d.tap_id("product-p-1003"); d.wait(3); d.back(); d.wait(3)
    d.log("== phase js-fatal")
    d.tap_id("action-js-fatal"); d.wait(5, "app terminates")
    d.launch(); d.wait(10, "relaunch sends the stored fatal event")
    d.log("== phase crash")
    d.tap_id("action-native-crash"); d.wait(5, "app crashes")
    d.launch(); d.wait(15, "relaunch sends the crash and the crashed session")
    d.log("== phase end"); d.wait(5); d.stop()


def replay(d, a):
    d.stop(); d.wait(1); d.launch(); d.wait(6, "app start")
    start = time.time()
    d.log(f"== replay loop for {a.replay_seconds}s")
    loop = [
        ("tap", "product-p-1001"), ("tap", "btn-Add to cart"), ("tap", "btn-Go to cart"), ("tap", "btn-Back to products"),
        ("tap", "action-fetch-ok"), ("tap", "action-browse-catalog"), ("top", None), ("tap", "product-p-1002"), ("back", None),
        ("tap", "action-search"), ("tap", "action-handled-error"), ("top", None), ("tap", "btn-Open cart"), ("back", None),
    ]
    i = 0
    while time.time() - start < a.replay_seconds:
        kind, rid = loop[i % len(loop)]
        if kind == "tap":
            d.tap_id(rid)
        elif kind == "back":
            d.back()
        else:
            d.top()
        i += 1
        time.sleep(2.5)
    d.log(f"loop done after {time.time() - start:.0f}s, {i} steps")
    d.home(); d.wait(8, "background flushes the last segment")
    d.stop()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", required=True)
    ap.add_argument("--phases", default="all", choices=["all", "replay"])
    ap.add_argument("--replay-seconds", type=int, default=120)
    ap.add_argument("--replay-wait", type=int, default=12)
    ap.add_argument("--bg-seconds", type=int, default=40)
    a = ap.parse_args()
    (full if a.phases == "all" else replay)(Device(a.serial), a)
