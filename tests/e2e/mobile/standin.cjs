/**
 * Native stand-in for one launch of the golden React Native iOS app (docs/specs/mobile-sdk.md
 * section 5). Loaded with `node --require`, before the built `@ouo11y/react-native` bundle:
 *
 * - the playground's react-native, AsyncStorage and ErrorUtils stand-ins (sdk/react-native/playground);
 * - `expo-modules-core` returning a model of the `OuoReplay` Expo module (sdk/react-native/ios) as it
 *   behaves today, at the boundary the JS calls: replay start / rotate / flush with frame chunks
 *   uploaded like the Swift `ChunkUploader`, the OuoCrash report file read on the next launch, app
 *   start info and cumulative frame counters;
 * - a `fetch` wrapper that logs every request to the collector (method, URL, content-encoding,
 *   status) and refuses them while `OUO_E2E_OFFLINE=1` (the network is down).
 *
 * The model follows the Swift code: a package that changes what the native module does changes
 * this file in the same PR (W1 crash-time chunks, W4 hangs and terminations).
 *
 * `globalThis.__ouoStandin` lets the journey act as the OS: crash(), terminate(), blockMainThread().
 * Env: OUO_E2E_DEVICE_DIR (this device's "disk"), OUO_E2E_COLLECTOR_ORIGINS (comma-separated
 * origins whose requests are logged and refused offline), OUO_E2E_OFFLINE.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Module = require("node:module");

require("../../../sdk/react-native/playground/preload.cjs");

const DEVICE_DIR = process.env.OUO_E2E_DEVICE_DIR;
if (!DEVICE_DIR) throw new Error("standin: OUO_E2E_DEVICE_DIR is required");
fs.mkdirSync(DEVICE_DIR, { recursive: true });
const CRASH_FILE = path.join(DEVICE_DIR, "ouo-crash.json");
const SEQ_FILE = path.join(DEVICE_DIR, "replay-seq.json");
const LOG_FILE = path.join(DEVICE_DIR, "standin.jsonl");
const OFFLINE = process.env.OUO_E2E_OFFLINE === "1";
const COLLECTOR = (process.env.OUO_E2E_COLLECTOR_ORIGINS ?? "").split(",").filter(Boolean);

const record = (entry) => fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid, ...entry }) + "\n");

// ---------------------------------------------------------------- network

const realFetch = globalThis.fetch;
globalThis.fetch = async function standinFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  if (!COLLECTOR.some((o) => url.startsWith(o))) return realFetch(input, init);
  const headers = new Headers(init.headers ?? {});
  const entry = { kind: "request", method: init.method ?? "GET", url, encoding: headers.get("content-encoding") ?? "identity" };
  if (OFFLINE) {
    record({ ...entry, status: "refused" });
    throw new TypeError("Network request failed");
  }
  const res = await realFetch(input, init);
  record({ ...entry, status: res.status });
  return res;
};

// ---------------------------------------------------------------- OuoReplay model

// "/9j/" is the base64 of a JPEG's FF D8 FF; the frame content is not what the checks read.
const FRAME = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGBwYHBwYGBwgJCwkICAoICAcHCg0KCgsMDAwMBwkODw0MDgsMDAz/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const readSeq = () => {
  try {
    return JSON.parse(fs.readFileSync(SEQ_FILE, "utf8"));
  } catch {
    return {};
  }
};

let recorder; // { endpoint, options, sessionId, frames, paused, timer }
let crashSessionId;
const uploads = [];

function capture(reason) {
  if (recorder && !recorder.paused && !recorder.background) recorder.frames.push({ ts: Date.now(), jpeg: FRAME, reason });
}

/** Sends the frames held for the current session as one chunk (Swift: ReplayRecorder.flush). */
function upload() {
  if (!recorder || recorder.frames.length === 0) return Promise.resolve();
  const { endpoint, options, sessionId } = recorder;
  const frames = recorder.frames.splice(0);
  const seqs = readSeq();
  const seq = seqs[sessionId] ?? 0;
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ ...seqs, [sessionId]: seq + 1 }));
  const chunk = {
    kind: "frames",
    schema_version: 1,
    session_id: sessionId,
    seq,
    started_at: frames[0].ts,
    ended_at: frames[frames.length - 1].ts,
    viewport: { width: 393, height: 852, scale: 0.5 },
    platform: "ios",
    frames,
    touches: [],
    masked: options.maskText,
  };
  const p = globalThis
    .fetch(`${endpoint.replace(/\/$/, "")}/v1/replay/chunks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        authorization: "Basic " + Buffer.from(`${options.projectId}:${options.projectToken}`).toString("base64"),
        "x-ouo-session-id": sessionId,
        "x-ouo-seq": String(seq),
      },
      body: zlib.gzipSync(JSON.stringify(chunk)),
    })
    .then((res) => record({ kind: "chunk", session_id: sessionId, seq, frames: frames.length, status: res.status }))
    .catch((err) => record({ kind: "chunk", session_id: sessionId, seq, frames: frames.length, status: String(err) }));
  uploads.push(p);
  return p;
}

const native = {
  // Replay (NativeReplayModule)
  start(endpoint, options) {
    record({ kind: "replay.start", endpoint, options: { ...options, projectToken: undefined } });
    recorder = { endpoint, options, sessionId: options.sessionId, frames: [], paused: false };
    recorder.timer = setInterval(() => capture("timer"), Math.max(1, options.frameInterval) * 1000);
    recorder.timer.unref();
    capture("resume");
  },
  setSessionId(id) {
    if (recorder) recorder.sessionId = id;
  },
  sessionDidRotate(id) {
    record({ kind: "replay.rotate", session_id: id });
    upload();
    if (recorder) recorder.sessionId = id;
    capture("navigation");
  },
  pause() {
    if (recorder) recorder.paused = true;
    upload();
  },
  resume() {
    if (!recorder) return;
    recorder.paused = false;
    capture("resume");
  },
  isRecording: () => Boolean(recorder && !recorder.paused),
  flush: async () => {
    upload();
    await Promise.all(uploads);
  },
  stop() {
    if (recorder) clearInterval(recorder.timer);
    upload();
    recorder = undefined;
  },
  // Crash (NativeCrashModule): OuoCrash writes the report at crash time, the next launch takes it.
  installCrashReporter(sessionId) {
    crashSessionId = sessionId;
    return true;
  },
  setCrashSessionId(id) {
    crashSessionId = id;
  },
  takePendingCrash() {
    try {
      const raw = fs.readFileSync(CRASH_FILE, "utf8");
      fs.unlinkSync(CRASH_FILE);
      return raw;
    } catch {
      return null;
    }
  },
  // Vitals (NativeVitalsModule): the process start is this Node process's start.
  getAppStartInfo: () => ({ processStartMs: Math.round(performance.timeOrigin), type: "cold", prewarmed: false }),
  getFrameStats() {
    const total = Math.floor(performance.now() / 16.7);
    const slow = Math.floor(total / 40);
    return { total, slow, frozen: 0, delayMs: slow * 9, expectedFrameMs: 16.7 };
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "expo-modules-core") {
    return {
      requireNativeModule(name) {
        if (name !== "OuoReplay") throw new Error(`Cannot find native module '${name}'`);
        return native;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Swift stops on didEnterBackground (flushing the chunk) and captures again on didBecomeActive.
require("react-native").AppState.addEventListener("change", (state) => {
  if (!recorder) return;
  if (state === "background") {
    upload();
    recorder.background = true;
  } else if (state === "active" && recorder.background) {
    recorder.background = false;
    capture("resume");
  }
});

// ---------------------------------------------------------------- the OS

globalThis.__ouoStandin = {
  /** A native crash (SIGSEGV on the main thread): the report is written, the process dies, nothing is flushed. */
  crash() {
    const report = {
      version: 1,
      mechanism: "signal",
      timestamp_ms: Date.now(),
      session_id: crashSessionId ?? "",
      arch: "arm64",
      thread: { main: true },
      signal: { number: 11, name: "SIGSEGV", mach_exception: "EXC_BAD_ACCESS", address: "0x0000000000000010" },
      frames: [{ instruction_addr: "0x0000000100a1b2c4", image_addr: "0x0000000100000000" }],
      images: [{ code_file: "/private/var/containers/Bundle/Application/GOLDEN/OuoMobile.app/OuoMobile", debug_id: "6c2a7f1e-0b5d-3c41-9a6e-2f1d4b8c7e90", image_addr: "0x0000000100000000", image_size: 16777216, image_vmaddr: "0x0000000100000000" }],
    };
    fs.writeFileSync(CRASH_FILE, JSON.stringify(report));
    record({ kind: "os.crash", session_id: report.session_id });
    process.exit(0);
  },
  /** The system kills the app in the foreground (memory, watchdog): no report, nothing is flushed. */
  terminate() {
    record({ kind: "os.terminate" });
    process.exit(0);
  },
  /** The main thread blocks for `ms`. The native module has no hang detector yet (W4): nothing reports it. */
  blockMainThread(ms) {
    record({ kind: "os.main_thread_block", ms });
  },
};
