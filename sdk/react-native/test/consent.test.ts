/** Consent (spec PRV-1 to PRV-4): pending, grant, denial, withdrawal, separate categories. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentStorage } from "../src/consent";
import * as sdk from "../src/index";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { SESSION_STORAGE_KEY } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import { OUTBOX_KEY } from "../src/transport/outbox";
import type { RUMOptions } from "../src/types";
import { nativeReplay, resetNative } from "./mocks/expo-modules-core";
import { attr, BACKEND, baseOptions, ENDPOINT, g, installErrorUtils, installFetchStub, sleep, type Captured } from "./support/otlp";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  installErrorUtils();
  resetNative();
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
  delete g.expo;
});

/** A storage that records what is written to it. */
function spiedStorage() {
  const storage = new MemoryAsyncStorage();
  const writes: string[] = [];
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    return set(key, value);
  };
  const keys = (): string[] => {
    const all = [SESSION_STORAGE_KEY, "ouo.user", "ouo.crash", "ouo.context", OUTBOX_KEY, ...Array.from({ length: 50 }, (_, i) => `${OUTBOX_KEY}.${i + 1}`)];
    return all.filter((k) => storage.peek(k) !== null);
  };
  return { storage, writes, keys };
}

async function start(extra: Partial<RUMOptions>, storage: MemoryAsyncStorage): Promise<{ rum: RUMInternal; captured: Captured & { exports: number } }> {
  const captured = installFetchStub() as Captured & { exports: number };
  const stub = globalThis.fetch;
  captured.exports = 0;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).startsWith(ENDPOINT)) captured.exports++;
    return stub(url, init);
  }) as typeof fetch;
  const rum = initRUM({ ...baseOptions(storage), ...extra } as RUMOptions) as RUMInternal;
  await rum.ready;
  return { rum, captured };
}

const settle = async (rum: RUMInternal): Promise<void> => {
  await rum.flush();
  await sleep(30);
};

describe("consent", () => {
  it("PRV-1, PRV-2: pending sends nothing, writes nothing and starts no replay; a grant processes what was held", async () => {
    const recoverPendingChunk = vi.fn();
    g.expo = { modules: { OuoReplay: { ...nativeReplay, recoverPendingChunk } } };
    const { storage, writes, keys } = spiedStorage();
    const { rum, captured } = await start({ consent: { required: true }, replay: { enabled: true }, user: { id: "u-1" } }, storage);
    const id = rum.getSessionId()!;
    rum.recordEvent("while.pending");
    rum.recordException(new Error("while pending"));
    rum.trackNavigation("/Home");
    await fetch(`${BACKEND}/api/a`);
    await settle(rum);
    expect(captured.exports).toBe(0);
    expect(writes).toEqual([]);
    expect(keys()).toEqual([]);
    expect(nativeReplay.start).not.toHaveBeenCalled();
    expect(recoverPendingChunk).not.toHaveBeenCalled();
    // The app's own request is not the SDK's business.
    expect(captured.requests).toHaveLength(1);

    // Telemetry granted, replay not: the held records go out, in order, on the session they were made in.
    sdk.setConsent({ telemetry: true });
    await settle(rum);
    expect(captured.exports).toBeGreaterThan(0);
    expect(captured.logs.map((l) => attr(l.attributes, "event.name"))).toEqual(["session.start", "while.pending", "exception", "navigation", "http.request"]);
    expect(captured.logs.every((l) => attr(l.attributes, "session.id") === id)).toBe(true);
    expect(captured.spans).toHaveLength(1);
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).id).toBe(id);
    expect(JSON.parse(storage.peek("ouo.user")!)).toEqual({ id: "u-1", anonymous: false });
    // PRV-3: replay needs its own consent.
    expect(nativeReplay.start).not.toHaveBeenCalled();
    rum.setConsent({ replay: true });
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    expect((nativeReplay.start.mock.calls[0]![1] as { sessionId: string }).sessionId).toBe(id);
    // Legacy upload path only: replay over OTLP never calls it (the native queue recovers by itself).
    expect(recoverPendingChunk).not.toHaveBeenCalled();
  });

  it("PRV-2: a denial discards what was held; nothing is ever sent or written", async () => {
    const { storage, writes, keys } = spiedStorage();
    const { rum, captured } = await start({ consent: { required: true } }, storage);
    rum.recordEvent("held.then.discarded");
    await settle(rum);
    rum.setConsent({ telemetry: false, replay: false });
    rum.recordEvent("after.denial");
    await settle(rum);
    expect(captured.exports).toBe(0);
    expect(writes).toEqual([]);
    expect(keys()).toEqual([]);
    expect(rum.getSessionId()).toBeUndefined();
  });

  it("PRV-4: withdrawal stops capture, deletes unsent persisted data and the persisted session; a later grant starts a new session without previous_id", async () => {
    const { storage, keys } = spiedStorage();
    const { rum, captured } = await start({}, storage);
    const first = rum.getSessionId()!;
    rum.recordEvent("sent.before");
    await settle(rum);
    expect(captured.byName("sent.before")).toHaveLength(1);
    expect(keys()).toContain(SESSION_STORAGE_KEY);

    // The collector goes away: what is recorded now stays on the device, unsent.
    const working = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => (String(url).startsWith(ENDPOINT) ? Promise.resolve(new Response("{}", { status: 503 })) : working(url, init))) as typeof fetch;
    rum.recordEvent("unsent.1");
    await settle(rum);
    rum.recordEvent("unsent.2"); // still in the batch queue
    expect(keys().some((k) => k.startsWith(`${OUTBOX_KEY}.`))).toBe(true);

    rum.setConsent({ telemetry: false });
    rum.recordEvent("after.withdrawal");
    rum.recordException(new Error("after withdrawal"));
    await fetch(`${BACKEND}/api/a`);
    await sleep(50);
    // Nothing of the SDK is left on the device.
    expect(keys()).toEqual([]);
    expect(rum.getSessionId()).toBeUndefined();

    // The collector is back: nothing of the withdrawn period is sent.
    globalThis.fetch = working;
    const before = captured.logs.length;
    await settle(rum);
    expect(captured.logs.length).toBe(before);

    // A later grant: a new session, with no link to the one before.
    rum.setConsent({ telemetry: true });
    const second = rum.getSessionId()!;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    rum.recordEvent("after.grant");
    await settle(rum);
    const names = captured.logs.slice(before).map((l) => attr(l.attributes, "event.name"));
    expect(names).toEqual(["session.start", "after.grant"]);
    const startRecord = captured.logs[before]!;
    expect(attr(startRecord.attributes, "session.id")).toBe(second);
    expect(attr(startRecord.attributes, "session.previous_id")).toBeUndefined();
    expect(JSON.stringify(captured.logs)).not.toContain("unsent");
    expect(JSON.stringify(captured.logs)).not.toContain("withdrawal");
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).id).toBe(second);
  });

  it("PRV-3: replay consent is separate: withdrawing it stops the recorder and telemetry goes on", async () => {
    const discardPending = vi.fn();
    g.expo = { modules: { OuoReplay: { ...nativeReplay, discardPending } } };
    const { rum, captured } = await start({ replay: { enabled: true } }, new MemoryAsyncStorage());
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    rum.setConsent({ replay: false });
    expect(nativeReplay.stop).toHaveBeenCalledTimes(1);
    expect(discardPending).toHaveBeenCalledTimes(1);
    expect(rum.replay.isRecording()).toBe(false);
    // A session rotation does not bring it back.
    rum.restartSession();
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    rum.recordEvent("telemetry.continues");
    await settle(rum);
    expect(captured.byName("telemetry.continues")).toHaveLength(1);
    rum.setConsent({ replay: true });
    expect(nativeReplay.start).toHaveBeenCalledTimes(2);
    expect((nativeReplay.start.mock.calls[1]![1] as { sessionId: string }).sessionId).toBe(rum.getSessionId());
    // Malformed input changes nothing and does not throw.
    for (const junk of [undefined, null, 5, "yes", { telemetry: "yes" }]) expect(() => rum.setConsent(junk as never)).not.toThrow();
    expect(rum.getSessionId()).toBeDefined();
  });

  it("the buffer held while pending is bounded", async () => {
    const { rum, captured } = await start({ consent: { required: true }, transport: { offline: { maxBytes: 20_000 } } }, new MemoryAsyncStorage());
    for (let i = 0; i < 40; i++) {
      rum.recordEvent(`held.${i}`, { filler: "x".repeat(300) });
      await rum.flush();
    }
    rum.setConsent({ telemetry: true });
    await settle(rum);
    const sent = captured.logs.filter((l) => String(attr(l.attributes, "event.name")).startsWith("held.")).length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(30);
    // The newest survived, the oldest were evicted (and counted: the drop report is among what was sent).
    expect(captured.byName("held.38").length + captured.byName("held.39").length).toBeGreaterThan(0);
    expect(captured.byName("held.0")).toHaveLength(0);
    expect(captured.byName("ouo.sdk.dropped").some((l) => attr(l.attributes, "ouo.sdk.drop.reason") === "outbox_evicted")).toBe(true);
  });
});

describe("ConsentStorage", () => {
  it("holds writes in memory until allowed, then writes them out; purge deletes from the real storage", async () => {
    const inner = new MemoryAsyncStorage();
    await inner.setItem("old", "from an earlier run");
    const s = new ConsentStorage(inner, false);
    await s.setItem("a", "1");
    await s.removeItem("old");
    expect(await s.getItem("a")).toBe("1");
    expect(await s.getItem("old")).toBeNull();
    expect(inner.peek("a")).toBeNull();
    expect(inner.peek("old")).toBe("from an earlier run");
    await s.allow();
    expect(inner.peek("a")).toBe("1");
    expect(inner.peek("old")).toBeNull();
    await s.setItem("b", "2");
    expect(inner.peek("b")).toBe("2");
    s.hold();
    await s.setItem("c", "3");
    expect(inner.peek("c")).toBeNull();
    await s.purge(["a", "b", "c"]);
    expect(inner.peek("a")).toBeNull();
    expect(inner.peek("b")).toBeNull();
    expect(await s.getItem("c")).toBeNull();
    // A storage that fails does not make consent changes throw.
    const broken = new ConsentStorage({ getItem: () => Promise.reject(new Error("x")), setItem: () => Promise.reject(new Error("x")), removeItem: () => { throw new Error("x"); } }, false);
    await broken.setItem("k", "v");
    await expect(broken.allow()).resolves.toBeUndefined();
    await expect(broken.purge(["k"])).resolves.toBeUndefined();
  });
});
