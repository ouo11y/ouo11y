/** Transport rules of spec section 8 (TRN-4, TRN-6, TRN-7, TRN-8, TRN-11, TRN-14). */
import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropCounter } from "../src/drops";
import { MemoryAsyncStorage } from "../src/session/storage";
import { OutboxExporter } from "../src/transport/exporter";
import { Outbox, RETRY_MAX_MS, type SendResult } from "../src/transport/outbox";
import { createSend, partialRejected } from "../src/transport/send";

const logger = { enabled: false, log: () => undefined, warn: () => undefined };
const tick = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => {
      timers = timers.filter((t) => t !== h);
    },
    pending: () => timers.map((t) => t.at - now),
    async advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t);
        t.fn();
      }
      await tick();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("partial success (spec 8.2)", () => {
  it("reads rejected counts from an OTLP/HTTP JSON answer", () => {
    expect(partialRejected('{"partialSuccess":{"rejectedLogRecords":"3","errorMessage":"too old"}}')).toBe(3);
    expect(partialRejected('{"partialSuccess":{"rejectedSpans":2}}')).toBe(2);
    expect(partialRejected('{"partial_success":{"rejected_log_records":1}}')).toBe(1);
    for (const none of ["", "{}", '{"partialSuccess":{}}', '{"partialSuccess":{"rejectedLogRecords":"0"}}', '{"partialSuccess":{"rejectedSpans":-1}}', "not json partial", null, undefined, '{"partialSuccess":null}']) {
      expect(partialRejected(none)).toBe(0);
    }
  });

  it("the fetch transport reports it; 204 with no body is accepted", async () => {
    const answers: Response[] = [new Response('{"partialSuccess":{"rejectedLogRecords":4}}', { status: 200 }), new Response(null, { status: 204 }), new Response('{"partialSuccess":{"rejectedLogRecords":4}}', { status: 400 })];
    vi.stubGlobal("fetch", async () => answers.shift()!);
    const send = createSend({}, undefined);
    expect(await send("u", "{}")).toEqual({ status: 200, rejected: 4 });
    expect(await send("u", "{}")).toEqual({ status: 204 });
    expect(await send("u", "{}")).toEqual({ status: 400 });
    // The native transport, when it returns the body.
    const native = createSend({}, { postOtlp: async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":"7"}}' }) });
    expect(await native("u", "{}")).toEqual({ status: 200, rejected: 7 });
    vi.unstubAllGlobals();
  });

  it("a 2xx with rejected records is deleted, not retried, and counted partial_rejected; other statuses rejected_status", async () => {
    const drops = new DropCounter();
    const answers: SendResult[] = [{ status: 200, rejected: 2 }, { status: 400 }, { status: 200 }];
    const send = vi.fn(async () => answers.shift() ?? { status: 200 });
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send, logger, drops });
    await outbox.put("http://c/v1/logs", "a", 5);
    await outbox.put("http://c/v1/traces", "b", 3);
    await outbox.put("http://c/v1/logs", "c", 1);
    await outbox.drain();
    expect(send).toHaveBeenCalledTimes(3);
    expect(outbox.size).toBe(0);
    expect(drops.total("log", "partial_rejected")).toBe(2);
    expect(drops.total("span", "rejected_status")).toBe(3);
    expect(outbox.stats).toEqual({ sent: 2, rejected: 1, dropped: 0 });
  });
});

describe("retries (TRN-7, TRN-8)", () => {
  it("full jitter: each wait is a random part of a ceiling that doubles from 1 s to 300 s", async () => {
    const clock = fakeClock();
    let r = 0;
    const randoms = [0, 0.5, 0.25, 1, 0.1];
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send: async () => ({ status: 502 }), logger, clock, random: () => randoms[r++ % randoms.length]! });
    await outbox.put("u", "a");
    await tick();
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      const [w] = clock.pending();
      waits.push(w!);
      await clock.advance(w!);
    }
    const ceilings = [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000];
    expect(waits).toEqual(ceilings.map((c, i) => Math.round(randoms[i % randoms.length]! * c)));
    for (const [i, w] of waits.entries()) expect(w).toBeLessThanOrEqual(ceilings[i]!);
  });

  it("Retry-After is honoured as given and capped at the maximum", async () => {
    const clock = fakeClock();
    const answers: SendResult[] = [{ status: 429, retryAfterMs: 7000 }, { status: 503, retryAfterMs: 86_400_000 }, { status: 503, retryAfterMs: 0 }];
    const outbox = new Outbox({ storage: new MemoryAsyncStorage(), send: async () => answers.shift() ?? { status: 200 }, logger, clock, random: () => 0.5 });
    await outbox.put("u", "a");
    await tick();
    expect(clock.pending()).toEqual([7000]);
    await clock.advance(7000);
    expect(clock.pending()).toEqual([RETRY_MAX_MS]);
    await clock.advance(RETRY_MAX_MS);
    expect(clock.pending()).toEqual([0]);
    await clock.advance(0);
    expect(outbox.size).toBe(0);
  });
});

describe("eviction (TRN-11, TRN-14)", () => {
  it("oldest first, and requests holding bypass-set records last", async () => {
    const drops = new DropCounter();
    const storage = new MemoryAsyncStorage();
    const clock = fakeClock();
    const outbox = new Outbox({ storage, send: async () => ({ status: 0 }), logger, clock, drops, maxEntries: 3, random: () => 1 });
    await outbox.put("http://c/v1/logs", "crash", 1, true);
    await outbox.put("http://c/v1/logs", "old", 2);
    await outbox.put("http://c/v1/logs", "mid", 2);
    await outbox.put("http://c/v1/logs", "new", 2);
    // The ordinary oldest went, the older crash request stayed.
    expect(drops.total("log", "outbox_evicted")).toBe(2);
    const kept = async (): Promise<string[]> => {
      const index = JSON.parse(storage.peek("ouo.outbox")!) as { items: Array<{ id: number }> };
      return index.items.map((i) => storage.peek(`ouo.outbox.${i.id}`)!);
    };
    expect(await kept()).toEqual(["crash", "mid", "new"]);
    await outbox.put("http://c/v1/logs", "crash 2", 1, true);
    await outbox.put("http://c/v1/logs", "crash 3", 1, true);
    expect(await kept()).toEqual(["crash", "crash 2", "crash 3"]);
    // Only bypass requests are left: now the oldest of them goes.
    await outbox.put("http://c/v1/logs", "crash 4", 1, true);
    expect(await kept()).toEqual(["crash 2", "crash 3", "crash 4"]);
    outbox.stop();
  });
});

describe("request size (TRN-4)", () => {
  const serializer = { serializeRequest: (items: string[]) => new TextEncoder().encode(JSON.stringify(items)) };

  it("splits a batch over maxRequestBytes, drops and counts a record that alone is over it, never sends an empty request", async () => {
    const puts: Array<{ body: string; records: number; bypass: boolean }> = [];
    const outbox = { put: async (_url: string, body: string, records: number, bypass: boolean) => void puts.push({ body, records, bypass }) } as unknown as Outbox;
    const tooLarge = vi.fn();
    const exporter = new OutboxExporter<string>(serializer, "http://c/v1/logs", outbox, { maxRequestBytes: 40, onTooLarge: tooLarge, bypass: (s) => s.startsWith("crash") });
    const results: number[] = [];
    const items = ["aaaaaaaaaa", "bbbbbbbbbb", "crash-cccc", "d".repeat(100), "eeeeeeeeee"];
    exporter.export(items, (r) => results.push(r.code));
    exporter.export([], (r) => results.push(r.code));
    await tick();
    expect(results).toEqual([ExportResultCode.SUCCESS, ExportResultCode.SUCCESS]);
    for (const p of puts) expect(p.body.length).toBeLessThanOrEqual(40);
    // Every record but the oversized one, in order, each exactly once.
    expect(puts.flatMap((p) => JSON.parse(p.body) as string[])).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "crash-cccc", "eeeeeeeeee"]);
    expect(puts.reduce((n, p) => n + p.records, 0)).toBe(4);
    // The request that holds the bypass-set record is marked, the others are not.
    expect(puts.map((p) => p.bypass)).toEqual(puts.map((p) => p.body.includes("crash")));
    expect(puts.filter((p) => p.bypass)).toHaveLength(1);
    expect(puts.length).toBeGreaterThan(1);
    expect(tooLarge).toHaveBeenCalledTimes(1);
  });
});
