/**
 * Native stand-in for one launch of the golden React Native iOS app (docs/specs/mobile-sdk.md
 * section 5). Loaded with `node --require`, before the built `@ouo11y/react-native` bundle:
 *
 * - the playground's react-native, AsyncStorage and ErrorUtils stand-ins (sdk/react-native/playground);
 * - `globalThis.expo.modules.OuoReplay`, a model of the Expo module (sdk/react-native/ios) as it
 *   behaves today, at the boundary the JS calls: replay start / rotate / pause / flush with frames
 *   paced and chunks cut, spooled and uploaded like the Swift `ReplayRecorder`, `CapturePacer`,
 *   `ChunkBuilder`, `ChunkSpool` and `ChunkUploader` (the chunk queue folder, held sessions), the
 *   OTLP gzip + POST (`postOtlp`), the OuoCrash report (with the session's start) read on the
 *   next launch, app start info and cumulative frame counters;
 * - a `fetch` wrapper that logs every request to the collector (method, URL, content-encoding,
 *   status) and refuses them while `OUO_E2E_OFFLINE=1` (the network is down).
 *
 * The model follows the Swift code: a package that changes what the native module does changes
 * this file in the same PR (W4 hangs and terminations next).
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

// Swift (W1): ReplayRecorder (run-loop pacing, background, rotation), OuoReplayCore.CapturePacer
// (`session` mode: a frame per `frameInterval`; `navigation`: one per screen; start and resume
// request a frame at once), ChunkBuilder (a chunk keeps the session id and seq of its first frame;
// cut at 5 s, 10 frames or an explicit flush) and ChunkSpool (the open chunk on disk, sent by the
// next launch after a crash). Not modelled: the frame deduper (every frame is kept, as screens
// change between frames), motion and animation deferral, the time bank, touches. The device has
// more than 3.5 GiB, so `auto` is `session`.
const FLUSH_INTERVAL_MS = 5000;
const MAX_FRAMES = 10;
const SETTLE_DELAY_MS = 400;
const SPOOL_FILE = path.join(DEVICE_DIR, "open-chunk.jsonl");
let recorder; // { endpoint, options, mode, sessionId, recording, pausedByHost, pending, lastCaptureAt, chunk, loop, keepAlive }
let recovered = false;
let crashSession = { id: "", startedMs: 0 };
const uploads = [];

const nextSeq = (sessionId) => {
  const seqs = readSeq();
  const seq = seqs[sessionId] ?? 0;
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ ...seqs, [sessionId]: seq + 1 }));
  return seq;
};

/** ChunkBuilder.add with its spool: open the chunk at its first frame, cut at 10 frames or 5 s. */
function addFrame(reason) {
  const ts = Date.now();
  if (!recorder.chunk) {
    const sessionId = recorder.sessionId;
    recorder.chunk = { sessionId, seq: nextSeq(sessionId), startedAt: ts, frames: [] };
    fs.writeFileSync(SPOOL_FILE, JSON.stringify({ header: { sessionId, seq: recorder.chunk.seq, startedAt: ts, masked: recorder.options.maskText } }) + "\n");
  }
  const frame = { ts, jpeg: FRAME, reason };
  recorder.chunk.frames.push(frame);
  fs.appendFileSync(SPOOL_FILE, JSON.stringify({ frame }) + "\n");
  if (recorder.chunk.frames.length >= MAX_FRAMES) upload();
  else flushIfDue();
}

function flushIfDue() {
  if (recorder?.chunk && Date.now() - recorder.chunk.startedAt >= FLUSH_INTERVAL_MS) upload();
}

/** One main run-loop pass (CapturePacer.isDue / decide). */
function captureIfDue() {
  if (!recorder?.recording) return;
  const now = Date.now();
  const p = recorder.pending;
  const due = p ? p.at : recorder.mode === "session" ? (recorder.lastCaptureAt ?? now) + recorder.interval : undefined;
  if (due === undefined || now < due) return;
  recorder.pending = undefined;
  recorder.lastCaptureAt = now;
  addFrame(p?.reason ?? "timer");
}

// ChunkUploader (W3): every chunk is written to the queue folder (or `held/` with `holdUploads`)
// as its gzip body before it is sent, named `<queued ms>-<n>.<session>.<seq>.json.gz`, and removed
// on 2xx or a final rejection; a refused upload stays for `drain`, the next chunk or the next launch.
const OUTBOX = path.join(DEVICE_DIR, "outbox");
const HELD = path.join(OUTBOX, "held");
let queued = 0;
let draining = null;

function post(endpoint, options, { sessionId, seq, startedAt, frames, masked }) {
  const body = {
    kind: "frames",
    schema_version: 1,
    session_id: sessionId,
    seq,
    started_at: startedAt,
    ended_at: frames[frames.length - 1].ts,
    viewport: { width: 393, height: 852, scale: 0.5 },
    platform: "ios",
    frames,
    touches: [],
    masked,
  };
  const folder = options.holdUploads ? HELD : OUTBOX;
  fs.mkdirSync(folder, { recursive: true });
  const name = `${String(Date.now()).padStart(13, "0")}-${String(++queued).padStart(6, "0")}.${sessionId}.${seq}.json.gz`;
  fs.writeFileSync(path.join(folder, name), zlib.gzipSync(JSON.stringify(body)));
  record({ kind: options.holdUploads ? "chunk.held" : "chunk.queued", session_id: sessionId, seq, frames: frames.length });
  return drainOutbox(endpoint, options);
}

const chunkFiles = (folder) => {
  try {
    return fs.readdirSync(folder).filter((f) => f.endsWith(".json.gz")).sort();
  } catch {
    return [];
  }
};

/** ChunkUploader.drain: one at a time, oldest first, until the folder is empty or an upload fails (the file stays). */
function drainOutbox(endpoint, options) {
  if (draining) return draining;
  const run = (async () => {
    for (let name = chunkFiles(OUTBOX)[0]; name; name = chunkFiles(OUTBOX)[0]) {
      const [, sessionId, seq] = name.split(".");
      const file = path.join(OUTBOX, name);
      let status;
      try {
        const res = await globalThis.fetch(`${endpoint.replace(/\/$/, "")}/v1/replay/chunks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            authorization: "Basic " + Buffer.from(`${options.projectId}:${options.projectToken}`).toString("base64"),
            "x-ouo-session-id": sessionId,
            "x-ouo-seq": seq,
          },
          body: fs.readFileSync(file),
        });
        status = res.status;
      } catch (err) {
        status = String(err);
      }
      record({ kind: "chunk", session_id: sessionId, seq: Number(seq), status });
      const final = typeof status === "number" && (status < 400 || (status < 500 && status !== 408 && status !== 429));
      if (!final) return;
      fs.rmSync(file, { force: true });
    }
  })().finally(() => {
    draining = null;
  });
  draining = run;
  uploads.push(run);
  return run;
}

/** Cuts the open chunk, clears the spool and uploads it (ChunkBuilder.flush, then ChunkUploader). */
function upload() {
  const chunk = recorder?.chunk;
  if (!chunk) return Promise.resolve();
  recorder.chunk = undefined;
  fs.rmSync(SPOOL_FILE, { force: true });
  return post(recorder.endpoint, recorder.options, { ...chunk, masked: recorder.options.maskText });
}

/** ReplayRecorder.recoverSpool: the chunk a crash left open, once per process. */
function recoverSpool(endpoint, options) {
  if (recovered) return;
  recovered = true;
  let lines;
  try {
    lines = fs.readFileSync(SPOOL_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    drainOutbox(endpoint, options);
    return;
  }
  fs.rmSync(SPOOL_FILE, { force: true });
  const header = lines.find((l) => l.header)?.header;
  const frames = lines.filter((l) => l.frame).map((l) => l.frame);
  if (!header || frames.length === 0) {
    drainOutbox(endpoint, options);
    return;
  }
  record({ kind: "replay.recovered", session_id: header.sessionId, seq: header.seq, frames: frames.length });
  post(endpoint, options, { ...header, frames });
}

/** ReplayRecorder.resumeCapture: a frame at once, the run-loop observer and the keep-alive timer. */
function resumeCapture() {
  if (!recorder || recorder.recording) return;
  recorder.recording = true;
  recorder.pending = { reason: "resume", at: Date.now() };
  recorder.loop = setInterval(captureIfDue, 50); // the main run loop's passes
  recorder.keepAlive = setInterval(flushIfDue, Math.min(recorder.interval, 1000));
  recorder.loop.unref();
  recorder.keepAlive.unref();
  captureIfDue();
}

function stopCapture() {
  if (!recorder) return;
  clearInterval(recorder.loop);
  clearInterval(recorder.keepAlive);
  recorder.recording = false;
}

const native = {
  // Replay (NativeReplayModule)
  recoverPendingChunk(endpoint, options) {
    recoverSpool(endpoint, options);
  },
  start(endpoint, options) {
    record({ kind: "replay.start", endpoint, options: { ...options, projectToken: undefined } });
    recoverSpool(endpoint, options);
    const mode = options.mode === "navigation" ? "navigation" : "session";
    recorder = { endpoint, options, mode, interval: Math.max(0.1, options.frameInterval) * 1000, sessionId: options.sessionId, recording: false, pausedByHost: false };
    resumeCapture();
  },
  setSessionId(id) {
    if (recorder) recorder.sessionId = id;
  },
  /** Held sessions (`holdUploads`), listed after the spool recovery. */
  async heldReplaySessions(endpoint, options) {
    recoverSpool(endpoint, options);
    const groups = new Map();
    for (const name of chunkFiles(HELD)) {
      const [order, sessionId] = name.split(".");
      const at = Number(order.split("-")[0]);
      const g = groups.get(sessionId) ?? { sessionId, chunks: 0, bytes: 0, firstAt: at, lastAt: at };
      g.chunks++;
      g.bytes += fs.statSync(path.join(HELD, name)).size;
      g.lastAt = at;
      groups.set(sessionId, g);
    }
    return [...groups.values()];
  },
  releaseHeldReplay(endpoint, options, sessionId, keep) {
    for (const name of chunkFiles(HELD).filter((n) => n.split(".")[1] === sessionId)) {
      if (keep) fs.renameSync(path.join(HELD, name), path.join(OUTBOX, name));
      else fs.rmSync(path.join(HELD, name), { force: true });
    }
    record({ kind: "replay.release", session_id: sessionId, keep });
    if (keep) drainOutbox(endpoint, options);
  },
  sessionDidRotate(id) {
    // OuoReplayModule sets the id, then the recorder flushes the open chunk (it keeps the old id)
    // and resets the seq; nothing is captured here.
    record({ kind: "replay.rotate", session_id: id });
    if (recorder) recorder.sessionId = id;
    upload();
    fs.writeFileSync(SEQ_FILE, JSON.stringify({ ...readSeq(), [id]: 0 }));
  },
  screenDidChange() {
    if (recorder?.mode === "navigation") recorder.pending = { reason: "navigation", at: Date.now() + SETTLE_DELAY_MS };
  },
  pause() {
    if (!recorder) return;
    recorder.pausedByHost = true;
    stopCapture();
    upload();
  },
  resume() {
    if (!recorder) return;
    recorder.pausedByHost = false;
    resumeCapture();
  },
  isRecording: () => Boolean(recorder?.recording),
  flush: async () => {
    upload();
    if (recorder) drainOutbox(recorder.endpoint, recorder.options);
    await Promise.all(uploads);
  },
  stop() {
    stopCapture();
    upload();
    recorder = undefined;
  },
  // OTLP (W3): gzip and POST off the JS thread; status 0 when the request did not reach the server.
  async postOtlp(url, headers, body) {
    try {
      const res = await globalThis.fetch(url, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: zlib.gzipSync(body) });
      const ra = Number(res.headers.get("retry-after"));
      return Number.isFinite(ra) && res.headers.get("retry-after") !== null ? { status: res.status, retryAfterMs: ra * 1000 } : { status: res.status };
    } catch {
      return { status: 0 };
    }
  },
  // Crash (NativeCrashModule): OuoCrash writes the report at crash time, the next launch takes it.
  installCrashReporter(sessionId, startedAtMs) {
    crashSession = { id: sessionId, startedMs: startedAtMs };
    return true;
  },
  setCrashSessionId(id, startedAtMs) {
    crashSession = { id, startedMs: startedAtMs };
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

// Swift stops capturing and flushes on didEnterBackground, and resumes with an immediate frame on
// didBecomeActive unless the host paused it. Registered before the SDK's listener, as on a device
// the notification reaches native code before the JavaScript AppState event.
require("react-native").AppState.addEventListener("change", (state) => {
  if (!recorder) return;
  if (state === "background") {
    stopCapture();
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
      session_id: crashSession.id,
      ...(crashSession.startedMs > 0 && { session_started_ms: Math.round(crashSession.startedMs) }),
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
