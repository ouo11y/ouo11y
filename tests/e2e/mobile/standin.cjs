/**
 * Native stand-in for one launch of the golden React Native iOS app (docs/specs/mobile-sdk.md
 * section 5). Loaded with `node --require`, before the built `@ouo11y/react-native` bundle:
 *
 * - the playground's react-native, AsyncStorage and ErrorUtils stand-ins (sdk/react-native/playground);
 * - `globalThis.expo.modules.OuoReplay`, a model of the Expo module (sdk/react-native/ios) as it
 *   behaves today, at the boundary the JS calls: replay start / rotate / pause / flush with frame
 *   chunks cut and uploaded like the Swift `ReplayRecorder` and `ChunkBuilder`, the OuoCrash report
 *   file read on the next launch, app start info and cumulative frame counters;
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

// Swift: ReplayRecorder (timer, pause, background, rotation) and OuoReplayCore.ChunkBuilder (a chunk
// keeps the session id and seq of its first frame; cut at 5 s, 10 frames or an explicit flush).
// Not modelled: the frame deduper (every frame here is kept, as screens change between frames),
// touches and touch-triggered frames.
const FLUSH_INTERVAL_MS = 5000;
const MAX_FRAMES = 10;
let recorder; // { endpoint, options, sessionId, timer, pausedByHost, chunk }
let crashSessionId;
const uploads = [];

function capture(reason) {
  if (!recorder?.timer) return; // Swift: captureFrame guards isRecording
  const ts = Date.now();
  if (!recorder.chunk) {
    // ChunkBuilder.open: the chunk takes the current session id and its next seq at its first frame.
    const sessionId = recorder.sessionId;
    const seqs = readSeq();
    const seq = seqs[sessionId] ?? 0;
    fs.writeFileSync(SEQ_FILE, JSON.stringify({ ...seqs, [sessionId]: seq + 1 }));
    recorder.chunk = { sessionId, seq, startedAt: ts, frames: [] };
  }
  recorder.chunk.frames.push({ ts, jpeg: FRAME, reason });
  if (recorder.chunk.frames.length >= MAX_FRAMES) upload();
  else flushIfDue();
}

function flushIfDue() {
  if (recorder?.chunk && Date.now() - recorder.chunk.startedAt >= FLUSH_INTERVAL_MS) upload();
}

/** Cuts the open chunk and uploads it (Swift: ChunkBuilder.flush, then ChunkUploader). */
function upload() {
  const chunk = recorder?.chunk;
  if (!chunk) return Promise.resolve();
  recorder.chunk = undefined;
  const { endpoint, options } = recorder;
  const { sessionId, seq, frames } = chunk;
  const body = {
    kind: "frames",
    schema_version: 1,
    session_id: sessionId,
    seq,
    started_at: chunk.startedAt,
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
      body: zlib.gzipSync(JSON.stringify(body)),
    })
    .then((res) => record({ kind: "chunk", session_id: sessionId, seq, frames: frames.length, status: res.status }))
    .catch((err) => record({ kind: "chunk", session_id: sessionId, seq, frames: frames.length, status: String(err) }));
  uploads.push(p);
  return p;
}

/** Swift: resumeCapture, an immediate frame and the frame timer. */
function resumeCapture() {
  if (!recorder || recorder.timer) return;
  recorder.timer = setInterval(() => {
    capture("timer");
    flushIfDue();
  }, Math.max(1, recorder.options.frameInterval) * 1000);
  recorder.timer.unref();
  capture("resume");
}

function stopTimer() {
  if (recorder?.timer) clearInterval(recorder.timer);
  if (recorder) recorder.timer = undefined;
}

const native = {
  // Replay (NativeReplayModule)
  start(endpoint, options) {
    record({ kind: "replay.start", endpoint, options: { ...options, projectToken: undefined } });
    recorder = { endpoint, options, sessionId: options.sessionId, pausedByHost: false };
    resumeCapture();
  },
  setSessionId(id) {
    if (recorder) recorder.sessionId = id;
  },
  sessionDidRotate(id) {
    // OuoReplayModule sets the id, then the recorder flushes the open chunk (it keeps the old id)
    // and resets the seq; nothing is captured here.
    record({ kind: "replay.rotate", session_id: id });
    if (recorder) recorder.sessionId = id;
    upload();
    const seqs = readSeq();
    fs.writeFileSync(SEQ_FILE, JSON.stringify({ ...seqs, [id]: 0 }));
  },
  pause() {
    if (!recorder) return;
    recorder.pausedByHost = true;
    stopTimer();
    upload();
  },
  resume() {
    if (!recorder) return;
    recorder.pausedByHost = false;
    resumeCapture();
  },
  isRecording: () => Boolean(recorder?.timer),
  flush: async () => {
    upload();
    await Promise.all(uploads);
  },
  stop() {
    stopTimer();
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

// Expo registers every native module on `globalThis.expo.modules`, which the SDK reads first.
globalThis.expo = { modules: { OuoReplay: native } };

// Swift stops the timer and flushes on didEnterBackground, and resumes with an immediate frame on
// didBecomeActive unless the host paused it. Registered before the SDK's listener, as on a device
// the notification reaches native code before the JavaScript AppState event.
require("react-native").AppState.addEventListener("change", (state) => {
  if (!recorder) return;
  if (state === "background") {
    stopTimer();
    upload();
  } else if (state === "active" && !recorder.pausedByHost) {
    resumeCapture();
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
