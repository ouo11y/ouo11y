/**
 * Replay (SDK spec section 11): the contract on the wire through the public API with the
 * structure format, and the engine's format-independent rules with a stub adapter (RPL-23).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config";
import { systemClock } from "../src/core/clock";
import { DropCounter } from "../src/core/drops";
import * as ouo from "../src/index";
import { silentLogger } from "../src/logger";
import { createPipeline } from "../src/pipeline/otel";
import type { AdapterSink, ReplayAdapter } from "../src/replay/adapter";
import { BACKLOG_MAX_BYTES, recoverStreams, ReplayEngine, type EndReason } from "../src/replay/engine";
import { decodeFrames, frameRecord, maskedClone } from "../src/replay/pixel";
import { sha256, sha256Sync } from "../src/replay/sha256";
import { Http } from "../src/transport/http";
import { MemoryOutbox, toEvict, type OutboxMeta } from "../src/transport/store";
import { FakeCollector, gunzip, until, wait, type ReplayRecord } from "./helpers/collector";

const BASE = "http://collector.test:4318";
const collector = new FakeCollector(BASE);
const base: ouo.OuoConfig = { endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 100, persist: { enabled: false } } };
const SCHEMA = "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev";
const REQUIRED = [
  "session.id", "ouo.replay.id", "ouo.replay.stream.id", "ouo.replay.segment.index", "ouo.replay.sequence", "ouo.replay.keyframe", "ouo.replay.start_time", "ouo.replay.end_time",
  "ouo.replay.format", "ouo.replay.encoding", "ouo.replay.sha256", "ouo.replay.byte_size", "ouo.replay.masked", "ouo.replay.mode",
];

const hash = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const chunks = (): ReplayRecord[] => collector.replay.filter((r) => r.eventName === "ouo.replay.chunk").sort((a, b) => Number(a.attributes["ouo.replay.sequence"]) - Number(b.attributes["ouo.replay.sequence"]));
const ended = (): ReplayRecord[] => collector.replay.filter((r) => r.eventName === "ouo.replay.ended");

async function decodeRrweb(list: ReplayRecord[]): Promise<Array<{ type: number; data: Record<string, unknown> }>> {
  let text = "";
  for (const c of list) text += new TextDecoder().decode(c.attributes["ouo.replay.encoding"] === "gzip" ? await gunzip(c.body!) : c.body!);
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: number; data: Record<string, unknown> });
}

/** Checks the chunk contract on a whole stream (RPL-1 to RPL-13). */
function checkStream(list: ReplayRecord[]): void {
  expect(list.length).toBeGreaterThan(0);
  let segment = -1;
  list.forEach((c, i) => {
    for (const key of REQUIRED) expect(c.attributes[key], key).not.toBeUndefined();
    expect(c.scope).toBe("ouo.replay");
    expect(c.schemaUrl).toBe(SCHEMA);
    expect(c.attributes["ouo.replay.sequence"]).toBe(i);
    expect(c.attributes["ouo.replay.sha256"]).toBe(hash(c.body!));
    expect(c.attributes["ouo.replay.byte_size"]).toBe(c.body!.byteLength);
    expect(c.body!.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(c.attributes["ouo.replay.masked"]).toBe(true);
    expect(c.attributes["ouo.replay.ref"]).toBeUndefined();
    expect(Number(c.attributes["ouo.replay.end_time"])).toBeGreaterThanOrEqual(Number(c.attributes["ouo.replay.start_time"]));
    if (c.attributes["ouo.replay.keyframe"]) segment++;
    expect(c.attributes["ouo.replay.segment.index"]).toBe(segment);
  });
  expect(list[0]!.attributes["ouo.replay.keyframe"]).toBe(true);
  for (const key of ["session.id", "ouo.replay.id", "ouo.replay.stream.id"]) expect(new Set(list.map((c) => c.attributes[key])).size).toBe(1);
}

beforeEach(() => {
  localStorage.clear();
  collector.reset();
  collector.install();
  history.replaceState(null, "", "/account?token=abc");
  document.body.innerHTML = `
    <h1>Secret Heading</h1>
    <p data-ouo-unmask>Public text <span data-ouo-mask>Hidden inside unmask</span></p>
    <a href="/orders?customer=jane" title="Jane's orders">Orders</a>
    <input id="name" value="Jane Doe" placeholder="Your full name">
    <div data-ouo-unmask><input id="city" value="Cairo"><input id="pw" type="password" value="hunter2"><input id="otp" autocomplete="one-time-code" value="493021"></div>
    <img src="/avatar/jane.png" alt="Jane's face" width="40" height="40">
    <div data-ouo-unmask><img src="/logo.png" alt="Logo"></div>`;
});

afterEach(async () => {
  await ouo.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("structure replay on the wire (SIG-26, SIG-27, RPL-1 to RPL-14, PRV-5, PRV-6)", () => {
  it("sends ouo.replay.chunk records as OTLP protobuf, one per request, with identity, order, keyframes and hashes", async () => {
    ouo.init({ ...base, replay: { sessionRate: 1, chunkMaxMs: 250 } });
    await until(() => chunks().length >= 1, 5000);
    document.body.appendChild(Object.assign(document.createElement("p"), { textContent: "Added later secret" }));
    await until(() => chunks().length >= 2, 5000);
    await ouo.shutdown();
    await collector.settled();

    const list = chunks();
    checkStream(list);
    const replayRequests = collector.requests.filter((r) => r.headers["content-type"] === "application/x-protobuf");
    expect(replayRequests.length).toBe(list.length + ended().length);
    for (const r of replayRequests) {
      expect(r.url).toBe(`${BASE}/v1/logs`);
      // The body is compressed by the format layer; the request is not gzipped again.
      expect(r.headers["content-encoding"]).toBeUndefined();
    }
    expect(list[0]!.attributes).toMatchObject({ "ouo.replay.format": "rrweb/2", "ouo.replay.encoding": "gzip", "ouo.replay.mode": "session" });
    expect(list[0]!.attributes["ouo.replay.trigger"]).toBeUndefined();
    expect(list[0]!.attributes["ouo.view.id"]).toBeDefined();
    expect(list[0]!.attributes["ouo.replay.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(list[0]!.attributes["ouo.replay.stream.id"]).toMatch(/^[0-9a-f]{32}$/);

    const events = await decodeRrweb(list);
    expect(events[0]!.type).toBe(4);
    expect(events[1]!.type).toBe(2);
    expect(events[0]!.data["href"]).toBe("http://localhost:3000/account?token=REDACTED");

    const end = ended();
    expect(end).toHaveLength(1);
    expect(end[0]!.attributes).toMatchObject({
      "session.id": list[0]!.attributes["session.id"],
      "ouo.replay.id": list[0]!.attributes["ouo.replay.id"],
      "ouo.replay.stream.id": list[0]!.attributes["ouo.replay.stream.id"],
      "ouo.replay.end_state": "complete",
      "ouo.replay.end_reason": "stop",
      "ouo.replay.last_sequence": list.length - 1,
    });
    expect(end[0]!.scope).toBe("ouo.replay");
    // Replay records never ride with telemetry.
    expect(collector.logs.some((l) => l.eventName.startsWith("ouo.replay"))).toBe(false);
  });

  it("masks text as ***, form values, text attributes and blocks images; unmask and mask attributes work; secrets cannot be unmasked", async () => {
    ouo.init({ ...base, replay: { sessionRate: 1, chunkMaxMs: 250 } });
    await until(() => chunks().length >= 1, 5000);
    const city = document.getElementById("city") as HTMLInputElement;
    city.value = "Alexandria";
    city.dispatchEvent(new Event("input", { bubbles: true }));
    const name = document.getElementById("name") as HTMLInputElement;
    name.value = "John Smith";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(400);
    await ouo.shutdown();
    await collector.settled();
    const text = JSON.stringify(await decodeRrweb(chunks()));
    for (const secret of ["Secret Heading", "Hidden inside unmask", "Jane Doe", "John Smith", "Your full name", "Jane's orders", "Jane's face", "hunter2", "493021", "customer=jane", "jane.png"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain("***");
    expect(text).toContain("Public text");
    expect(text).toContain("Cairo");
    expect(text).toContain("Alexandria");
    expect(text).toContain("customer=REDACTED");
    // The unmasked image is recorded, the other is an empty box.
    expect(text).toContain("/logo.png");
  });

  it("buffer mode sends nothing until an unhandled error, then the ring and what follows, marked (SMP-10 to SMP-12)", async () => {
    ouo.init({ ...base, replay: { bufferRate: 1, chunkMaxMs: 250 } });
    document.body.appendChild(document.createElement("section"));
    await wait(900);
    expect(collector.replay).toHaveLength(0);
    expect(collector.requests.filter((r) => r.headers["content-type"] === "application/x-protobuf")).toHaveLength(0);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("trigger"), message: "trigger" }));
    await until(() => chunks().length >= 1, 5000);
    document.body.appendChild(document.createElement("article"));
    await wait(500);
    await ouo.shutdown();
    await collector.settled();
    const list = chunks();
    checkStream(list);
    for (const c of list) expect(c.attributes).toMatchObject({ "ouo.replay.mode": "buffer", "ouo.replay.trigger": "error" });
    expect((await decodeRrweb(list))[0]!.type).toBe(4);
    expect(ended()).toHaveLength(1);
  });

  it("replay.capture() triggers a buffered replay manually", async () => {
    ouo.init({ ...base, replay: { bufferRate: 1, chunkMaxMs: 250 } });
    await until(() => ouo.diagnostics().replayRecording, 5000);
    await wait(400);
    ouo.replay.capture();
    await until(() => chunks().length >= 1, 5000);
    expect(chunks()[0]!.attributes["ouo.replay.trigger"]).toBe("manual");
  });

  it.each([
    ["no rate set", {}],
    ["a technique of another platform", { replay: { mode: "pixel/frames", sessionRate: 1 } as never }],
    ["a shorthand", { replay: { mode: "structure", sessionRate: 1 } as never }],
    ["replay rate 0", { replay: { sessionRate: 0, bufferRate: 0 } }],
    ["session not sampled", { sampling: { sessionRate: 0 }, replay: { sessionRate: 1 } }],
    ["replay consent missing", { consent: { required: true }, replay: { sessionRate: 1 } }],
  ] as Array<[string, Partial<ouo.OuoConfig>]>)("does not record: %s (SMP-9, RPL-19, PRV-3)", async (_name, extra) => {
    ouo.init({ ...base, ...extra });
    if (extra.consent) ouo.setConsent({ telemetry: true });
    await wait(700);
    expect(ouo.diagnostics().replayRecording).toBe(false);
    expect(collector.replay).toHaveLength(0);
  });

  it("replay consent starts recording; withdrawing it stops and a new grant is a new replay (PRV-3, PRV-4)", async () => {
    ouo.init({ ...base, consent: { required: true }, replay: { sessionRate: 1, chunkMaxMs: 250 } });
    ouo.setConsent({ telemetry: true, replay: true });
    await until(() => chunks().length >= 1, 5000);
    const first = chunks()[0]!.attributes["ouo.replay.id"];
    ouo.setConsent({ replay: false });
    await wait(300);
    expect(ouo.diagnostics().replayRecording).toBe(false);
    const count = collector.replay.length;
    document.body.appendChild(document.createElement("p"));
    await wait(500);
    expect(collector.replay.length).toBe(count);
    ouo.setConsent({ replay: true });
    await until(() => collector.replay.some((r) => r.attributes["ouo.replay.id"] !== first), 5000);
  });

  it("replay.stop() ends the stream; replay.start() begins a new replay with a new id and stream", async () => {
    ouo.init({ ...base, replay: { sessionRate: 1, chunkMaxMs: 250 } });
    await until(() => chunks().length >= 1, 5000);
    ouo.replay.stop();
    await until(() => ended().length === 1, 5000);
    expect(ended()[0]!.attributes["ouo.replay.end_reason"]).toBe("stop");
    ouo.replay.start();
    await until(() => new Set(collector.replay.map((r) => r.attributes["ouo.replay.stream.id"])).size === 2, 5000);
    expect(new Set(collector.replay.map((r) => r.attributes["ouo.replay.id"])).size).toBe(2);
    expect(new Set(collector.replay.map((r) => r.attributes["session.id"])).size).toBe(1);
  });

  it("a stalled replay endpoint does not delay telemetry (TRN-3)", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const type = new Headers(init?.headers).get("content-type");
      return type === "application/x-protobuf" ? new Promise<Response>(() => undefined) : real(input, init);
    });
    ouo.init({ ...base, replay: { sessionRate: 1, chunkMaxMs: 250 } });
    await until(() => ouo.diagnostics().replayRecording, 5000);
    await wait(400);
    ouo.recordEvent("cart.add");
    await ouo.flush();
    await collector.settled();
    expect(collector.events("cart.add")).toHaveLength(1);
    expect(collector.replay).toHaveLength(0);
  });
});

// ---- the engine with a stub format adapter (RPL-23, RPL-27) ----

class StubAdapter implements ReplayAdapter {
  readonly format = "stub/1";
  sink: AdapterSink | undefined;
  keyframes = 0;
  constructor(readonly compress: boolean) {}
  /** Data the format emits before its first keyframe (rrweb's page-load events). */
  early: string[] = [];
  start(sink: AdapterSink): void {
    this.sink = sink;
    for (const e of this.early) this.push(e);
    this.push("K0", true);
  }
  requestKeyframe(): void {
    this.keyframes++;
    this.push(`K${this.keyframes}`, true);
  }
  stop(): void {
    this.sink = undefined;
  }
  push(text: string | Uint8Array, keyframe = false): void {
    this.sink?.data(typeof text === "string" ? new TextEncoder().encode(text) : text, { time: Date.now(), keyframe });
  }
}

function harness(o: { mode?: "session" | "buffer"; compress?: boolean; chunkMaxBytes?: number; outbox?: MemoryOutbox | null; bufferSeconds?: number } = {}) {
  const cfg = resolveConfig({ endpoint: BASE, serviceName: "web-store" }, () => undefined)!;
  const drops = new DropCounter();
  const pipeline = createPipeline({
    cfg,
    drops,
    stamp: () => ({ id: "a".repeat(32), sampled: true, expired: false, user: undefined }),
    baggageSessionId: () => undefined,
    viewId: () => "view1",
    documentUrl: () => "http://localhost/",
    sanitize: (u) => u,
    globalAttributes: () => ({}),
    active: () => true,
    logSink: () => undefined,
    spanSink: () => undefined,
  });
  const adapter = new StubAdapter(o.compress ?? false);
  const endings: EndReason[] = [];
  const http = new Http({ headers: {}, timeoutMs: 5000 });
  const outbox = o.outbox === undefined ? new MemoryOutbox(64 * 1024 * 1024) : o.outbox;
  const deps = {
    adapter,
    mode: o.mode ?? ("session" as const),
    replayId: "b".repeat(32),
    sessionId: "a".repeat(32),
    viewId: () => "view1",
    makeRecord: pipeline.makeReplayRecord,
    http,
    logsUrl: `${BASE}/v1/logs`,
    outbox,
    drops,
    log: silentLogger,
    clock: systemClock,
    settings: { chunkMaxBytes: o.chunkMaxBytes ?? 256 * 1024, chunkMaxMs: 100, keyframeIntervalMs: 300_000, bufferSeconds: o.bufferSeconds ?? 60, retryInitialMs: 20, retryMaxMs: 40, ttlMs: 72 * 3_600_000 },
    onEnded: (reason: EndReason) => void endings.push(reason),
  };
  const engine = new ReplayEngine(deps);
  return { engine, adapter, drops, outbox, endings, pipeline, deps, http };
}

const bodyText = (c: ReplayRecord): string => new TextDecoder().decode(c.body!);

describe("engine contract with a stub format (RPL-4 to RPL-11, RPL-15 to RPL-21, RPL-23)", () => {
  it("a keyframe starts a new chunk and a new segment; sequence never resets", async () => {
    const h = harness();
    h.engine.start();
    h.adapter.push("a");
    h.adapter.push("b");
    h.adapter.requestKeyframe();
    h.adapter.push("c");
    await wait(150);
    h.adapter.push("d");
    await h.engine.end("stop");
    await collector.settled();
    const list = chunks();
    checkStream(list);
    expect(list.map(bodyText)).toEqual(["K0ab", "K1c", "d"]);
    expect(list.map((c) => [c.attributes["ouo.replay.sequence"], c.attributes["ouo.replay.segment.index"], c.attributes["ouo.replay.keyframe"]])).toEqual([[0, 0, true], [1, 1, true], [2, 1, false]]);
    expect(list[0]!.attributes).toMatchObject({ "ouo.replay.format": "stub/1", "ouo.replay.encoding": "identity" });
    expect(ended()[0]!.attributes).toMatchObject({ "ouo.replay.end_state": "complete", "ouo.replay.last_sequence": 2, "ouo.replay.end_reason": "stop" });
    expect(h.endings).toEqual(["stop"]);
  });

  it.each(["session", "buffer"] as const)("%s mode: what the format emits before its first keyframe is discarded, so chunk 0 starts with the keyframe (RPL-6)", async (mode) => {
    const h = harness({ mode });
    h.adapter.early = ["dom-content-loaded", "load"];
    h.engine.start();
    h.adapter.push("a");
    await wait(150);
    h.adapter.push("b");
    h.engine.trigger("manual");
    await h.engine.end("stop");
    await collector.settled();
    const list = chunks();
    checkStream(list);
    expect(list.map(bodyText)).toEqual(["K0a", "b"]);
    expect(list.map((c) => [c.attributes["ouo.replay.sequence"], c.attributes["ouo.replay.segment.index"], c.attributes["ouo.replay.keyframe"]])).toEqual([[0, 0, true], [1, 0, false]]);
    expect(ended()[0]!.attributes).toMatchObject({ "ouo.replay.end_state": "complete", "ouo.replay.last_sequence": 1 });
  });

  it("a chunk larger than the limit is split, never truncated: the concatenation is the payload (RPL-7, RPL-11)", async () => {
    const h = harness({ compress: true, chunkMaxBytes: 4096 });
    h.engine.start();
    const big = crypto.getRandomValues(new Uint8Array(20_000));
    h.adapter.push(big);
    await h.engine.end("stop");
    await collector.settled();
    const list = chunks();
    checkStream(list);
    expect(list.length).toBeGreaterThan(4);
    const parts: number[] = [];
    for (const c of list) {
      expect(c.body!.byteLength).toBeLessThanOrEqual(4096);
      parts.push(...(await gunzip(c.body!)));
    }
    expect(parts).toEqual([...new TextEncoder().encode("K0"), ...big]);
    expect(list.filter((c) => c.attributes["ouo.replay.keyframe"])).toHaveLength(1);
  });

  it("a chunk is persisted before its first send and removed only after a 2xx; retries reuse the bytes (RPL-15, TRN-10, TRN-12)", async () => {
    const h = harness();
    collector.setAlways({ status: 503 });
    h.engine.start();
    h.adapter.push("a");
    await wait(250);
    const stored = await h.outbox!.list(Date.now(), Infinity);
    expect(stored.entries.map((e) => [e.kind, e.seq])).toEqual([["replay", 0]]);
    const attempts = collector.requests.length;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(new Set(collector.requests.map((r) => hash(r.body))).size).toBe(1);
    collector.setAlways(undefined);
    await until(() => chunks().length === 1, 3000);
    await until(async () => (await h.outbox!.list(Date.now(), Infinity)).entries.length === 0, 3000);
    await h.engine.end("stop");
  });

  it.each([[400, "rejected_status"], [413, "rejected_status"]])("a chunk refused with %i is dropped, counted, and the stream ends partial with a new keyframe first (RPL-8, RPL-21)", async (status, reason) => {
    const h = harness();
    h.engine.start();
    collector.next({ status });
    h.adapter.push("a");
    await wait(200);
    expect(h.adapter.keyframes).toBe(1);
    h.adapter.push("b");
    await h.engine.end("stop");
    await collector.settled();
    expect(h.drops.total("ouo.replay.chunk", reason as never)).toBe(1);
    expect(ended()[0]!.attributes["ouo.replay.end_state"]).toBe("partial");
    const list = chunks();
    expect(list[0]!.attributes["ouo.replay.keyframe"]).toBe(true);
    // Sequence numbers are not renumbered over the gap (RPL-17).
    expect(list.map((c) => c.attributes["ouo.replay.sequence"])).not.toContain(0);
  });

  it("a backlog drops whole chunks of the oldest segment, marks the stream partial, and stops capture when nothing more fits (RPL-17, RPL-18)", async () => {
    const h = harness({ chunkMaxBytes: 512 * 1024 });
    collector.setAlways({ status: 503 });
    h.engine.start();
    const piece = new Uint8Array(600 * 1024);
    for (let i = 0; i < 12 && h.endings.length === 0; i++) {
      h.adapter.push(piece);
      await wait(30);
    }
    await wait(100);
    expect(h.drops.total("ouo.replay.chunk", "backlog")).toBeGreaterThan(0);
    expect(h.adapter.keyframes).toBeGreaterThan(0);
    const stored = (await h.outbox!.list(Date.now(), Infinity)).entries.reduce((n, e) => n + e.bytes, 0);
    expect(stored).toBeLessThanOrEqual(BACKLOG_MAX_BYTES + 1024 * 1024);
    collector.setAlways(undefined);
    await h.engine.end("stop");
    await until(() => ended().length === 1, 5000);
    expect(ended()[0]!.attributes["ouo.replay.end_state"]).toBe("partial");
  }, 15_000);

  it("the buffer ring keeps whole segments that cover the window and always starts at a keyframe (SMP-10, SMP-11)", async () => {
    const outbox = new MemoryOutbox(64 * 1024 * 1024);
    const h = harness({ mode: "buffer", outbox, bufferSeconds: 5 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      h.engine.start();
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(Date.now() + 3000);
        h.adapter.requestKeyframe();
        h.adapter.push(`x${i}`);
        // Let the chunk reach the ring while the clock still says "then".
        await h.engine.idle();
      }
    } finally {
      vi.useRealTimers();
    }
    await wait(200);
    // Nothing is stored or sent before a trigger.
    expect((await outbox.list(Date.now(), Infinity)).entries).toHaveLength(0);
    expect(await outbox.streams()).toHaveLength(0);
    expect(collector.requests).toHaveLength(0);
    h.engine.trigger("error");
    await h.engine.end("stop");
    await collector.settled();
    const list = chunks();
    checkStream(list);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThan(6);
    expect(bodyText(list[0]!).startsWith("K")).toBe(true);
    expect(bodyText(list[list.length - 1]!)).toContain("x5");
    for (const c of list) expect(c.attributes).toMatchObject({ "ouo.replay.mode": "buffer", "ouo.replay.trigger": "error" });
  });

  it("a buffer that is never triggered ends without a record", async () => {
    const h = harness({ mode: "buffer" });
    h.engine.start();
    h.adapter.push("a");
    await h.engine.end("session_end");
    await collector.settled();
    expect(collector.requests).toHaveLength(0);
  });

  it("page hide: the open chunk is closed uncompressed and stored with the end record, synchronously (LIF-7, TRN-19)", async () => {
    const h = harness({ compress: true });
    h.engine.start();
    h.adapter.push("abc");
    h.engine.onPageHide();
    // No await between the event and these assertions.
    expect(h.endings).toEqual(["pagehide"]);
    expect(collector.requests).toHaveLength(0);
    h.engine.flushUnload();
    await wait(50);
    await collector.settled();
    const list = chunks();
    expect(list).toHaveLength(1);
    expect(list[0]!.attributes["ouo.replay.encoding"]).toBe("identity");
    expect(bodyText(list[0]!)).toBe("K0abc");
    expect(list[0]!.attributes["ouo.replay.sha256"]).toBe(hash(list[0]!.body!));
    expect(ended()[0]!.attributes).toMatchObject({ "ouo.replay.end_reason": "pagehide", "ouo.replay.end_state": "complete", "ouo.replay.last_sequence": 0 });
    for (const r of collector.requests) expect(r.keepalive).toBe(true);
  });

  it("a later page sends what a dead page left behind, then says the stream ended partial (TRN-18, RPL-20)", async () => {
    const outbox = new MemoryOutbox(64 * 1024 * 1024);
    const h = harness({ outbox });
    collector.setAlways({ fail: true });
    h.engine.start();
    h.adapter.push("a");
    await wait(150);
    h.adapter.push("b");
    await wait(150);
    // The page dies here: no end record, two chunks in the outbox.
    const row = (await outbox.streams())[0]!;
    expect(row).toMatchObject({ stream: h.engine.streamId, last: 1, ended: false });
    collector.reset();
    collector.install();

    const next = harness({ outbox });
    // jsdom has no Web Locks: without them a stream is taken over once it has been quiet for two minutes.
    const later = { ...systemClock, now: () => Date.now() + 180_000 };
    const clean = await recoverStreams({ outbox, http: next.http, logsUrl: `${BASE}/v1/logs`, makeRecord: next.pipeline.makeReplayRecord, drops: next.drops, clock: later, ttlMs: 72 * 3_600_000, own: new Set() });
    await collector.settled();
    expect(clean).toBe(true);
    expect(chunks().map(bodyText)).toEqual(["K0a", "b"]);
    expect(chunks().every((c) => c.attributes["ouo.replay.stream.id"] === h.engine.streamId)).toBe(true);
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.attributes).toMatchObject({ "ouo.replay.stream.id": h.engine.streamId, "session.id": "a".repeat(32), "ouo.replay.end_state": "partial", "ouo.replay.last_sequence": 1, "ouo.replay.end_reason": "background_kill" });
    expect((await outbox.list(Date.now(), Infinity)).entries).toHaveLength(0);
    expect(await outbox.streams()).toHaveLength(0);
  });

  it("the request for a chunk leaves only after the outbox has it, and the stored copy goes once it is accepted (RPL-15)", async () => {
    const order: string[] = [];
    const outbox = new (class extends MemoryOutbox {
      override async put(e: Parameters<MemoryOutbox["put"]>[0]) {
        await wait(40);
        order.push("stored");
        return super.put(e);
      }
    })(64 * 1024 * 1024);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      // Only this test's chunk: engines of earlier tests may still be retrying.
      if (new TextDecoder().decode(init?.body as Uint8Array).includes("persist-me")) order.push("sent");
      return real(input, init);
    });
    const h = harness({ outbox });
    h.engine.start();
    h.adapter.push("persist-me");
    await h.engine.end("stop");
    await collector.settled();
    // Stored (the chunk), sent (the chunk), stored (the end record).
    expect(order.slice(0, 2)).toEqual(["stored", "sent"]);
    expect(order.filter((x) => x === "sent")).toHaveLength(1);
    expect((await outbox.list(Date.now(), Infinity)).entries).toHaveLength(0);
  });

  it("recovering a dead page's stream does not disturb the stream this page records", async () => {
    const outbox = new MemoryOutbox(64 * 1024 * 1024);
    await outbox.putStream({ stream: "d".repeat(32), replay: "e".repeat(32), session: "f".repeat(32), last: 0, ended: false, partial: false, mode: "session", updatedAt: Date.now() - 600_000 });
    const h = harness({ outbox });
    h.engine.start();
    h.adapter.push("a");
    await wait(150);
    const later = { ...systemClock, now: () => Date.now() + 180_000 };
    await recoverStreams({ outbox, http: h.http, logsUrl: `${BASE}/v1/logs`, makeRecord: h.pipeline.makeReplayRecord, drops: h.drops, clock: later, ttlMs: 72 * 3_600_000, own: new Set([h.engine.streamId]) });
    await collector.settled();
    expect(ended().map((e) => e.attributes["ouo.replay.stream.id"])).toEqual(["d".repeat(32)]);
    h.adapter.push("b");
    await wait(200);
    await collector.settled();
    expect(h.drops.total("ouo.replay.chunk", "internal_error")).toBe(0);
    expect(chunks().filter((c) => c.attributes["ouo.replay.stream.id"] === h.engine.streamId)).toHaveLength(2);
    expect(h.adapter.keyframes).toBe(0);
    await h.engine.end("stop");
  });

  it("after a rejected chunk the rest of its segment is not sent (RPL-8)", async () => {
    const h = harness();
    collector.setAlways({ status: 503 });
    h.engine.start();
    h.adapter.push("a");
    await wait(130);
    h.adapter.push("b");
    await wait(130);
    h.adapter.push("c");
    await wait(130);
    // Three chunks of segment 0 wait; the first is refused for good.
    collector.setAlways(undefined);
    collector.next({ status: 400 });
    await wait(300);
    h.adapter.push("d");
    await h.engine.end("stop");
    await collector.settled();
    const list = chunks();
    expect(list.every((c) => Number(c.attributes["ouo.replay.segment.index"]) >= 1)).toBe(true);
    expect(list[0]!.attributes["ouo.replay.keyframe"]).toBe(true);
    expect(ended()[0]!.attributes["ouo.replay.end_state"]).toBe("partial");
  });

  it("a frame the adapter could not mask is counted and makes the stream partial (PRV-8)", async () => {
    const h = harness();
    h.engine.start();
    h.adapter.sink!.dropped("mask_failed");
    h.adapter.push("a");
    await h.engine.end("stop");
    await collector.settled();
    expect(h.drops.total("ouo.replay.frame", "mask_failed")).toBe(1);
    expect(ended()[0]!.attributes["ouo.replay.end_state"]).toBe("partial");
  });
});

describe("hashing", () => {
  it("the synchronous SHA-256 agrees with the platform's for every block boundary", async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
      expect(sha256Sync(data)).toBe(hash(data));
      expect(await sha256(data)).toBe(hash(data));
    }
  });
});

describe("pixel format (ouo.frames/1)", () => {
  it("records concatenate and decode, payload bytes intact (RPL-7)", () => {
    const image = crypto.getRandomValues(new Uint8Array(500));
    const a = frameRecord({ t: 1, k: "frame", w: 10, h: 20, mime: "image/webp", masked: true }, image);
    const b = frameRecord({ t: 2, k: "pointer", x: 3, y: 4, p: "down" });
    const joined = new Uint8Array(a.byteLength + b.byteLength);
    joined.set(a);
    joined.set(b, a.byteLength);
    const out = decodeFrames(joined);
    expect(out.map((r) => r.header["k"])).toEqual(["frame", "pointer"]);
    expect([...out[0]!.payload]).toEqual([...image]);
    expect(out[1]!.payload.byteLength).toBe(0);
  });

  it("the clone that is drawn holds no text, value or media of the page outside data-ouo-unmask (PRV-5, PRV-6)", () => {
    document.body.innerHTML += `<script>var secretScript = 1</script><textarea>Private note</textarea><select><option selected>Chosen option</option></select><iframe src="/frame"></iframe><canvas></canvas><button onclick="steal()">Pay now</button>`;
    const doc = document.implementation.createHTMLDocument("");
    const clone = maskedClone(doc, document.body, { nodes: 10_000 })!;
    const html = new XMLSerializer().serializeToString(clone);
    for (const secret of ["Secret Heading", "Hidden inside unmask", "Jane Doe", "Your full name", "Jane's orders", "Jane's face", "hunter2", "493021", "customer=jane", "jane.png", "Private note", "Chosen option", "secretScript", "steal()", "/frame", "Pay now", "<img", "<iframe", "<canvas", "<script"]) {
      expect(html, secret).not.toContain(secret);
    }
    expect(html).toContain("Public text");
    expect(html).toContain("Cairo");
    // Masked text keeps its shape, not its letters.
    expect(html).toContain("****** *******");
    expect(() => maskedClone(doc, document.body, { nodes: 3 })).toThrow();
  });
});

describe("outbox eviction (TRN-13, TRN-14)", () => {
  const meta = (id: number, kind: OutboxMeta["kind"], bytes: number): OutboxMeta => ({ id, kind, signal: kind === "replay" ? "replay" : "logs", records: 1, createdAt: id, bytes });

  it("evicts replay first, then telemetry, then bypass records, oldest first, never the new entry", () => {
    const metas = [meta(1, "bypass", 10), meta(2, "telemetry", 10), meta(3, "replay", 10), meta(4, "replay", 10), meta(5, "telemetry", 10), meta(6, "replay", 10)];
    expect(toEvict(metas, 45, 6).map((m) => m.id)).toEqual([3, 4]);
    expect(toEvict(metas, 25, 6).map((m) => m.id)).toEqual([3, 4, 2, 5]);
    expect(toEvict(metas, 15, 6).map((m) => m.id)).toEqual([3, 4, 2, 5, 1]);
    expect(toEvict(metas, 100, 6)).toEqual([]);
  });

  it("the memory outbox honours the cap, the time to live and clearing one kind", async () => {
    const box = new MemoryOutbox(100);
    const body = new Uint8Array(40);
    await box.put({ kind: "replay", signal: "replay", body, records: 1, createdAt: 1000, stream: "s", seq: 0 });
    await box.put({ kind: "telemetry", signal: "logs", body, records: 3, createdAt: 2000 });
    const res = await box.put({ kind: "bypass", signal: "logs", body, records: 1, createdAt: 3000 });
    expect(res.evicted.map((m) => m.kind)).toEqual(["replay"]);
    expect((await box.put({ kind: "telemetry", signal: "logs", body: new Uint8Array(500), records: 1, createdAt: 1 })).id).toBeNull();
    const { entries, expired } = await box.list(2500 + 1000, 1000);
    expect(expired.map((m) => m.kind)).toEqual(["telemetry"]);
    expect(entries.map((m) => m.kind)).toEqual(["bypass"]);
    await box.clear("bypass");
    expect((await box.list(0, Infinity)).entries).toHaveLength(0);
  });
});
