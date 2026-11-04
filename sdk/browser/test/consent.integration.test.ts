/**
 * Consent (README, "Consent"; docs/specs/session-lifecycle.md, "No session before consent"):
 * nothing is stored, opened or sent while consent is pending, the queued calls run at the grant,
 * a revocation stops everything and wipes what the SDK stored, replay has its own switch, and an
 * app that never mentions consent sees no change.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_QUEUE_LIMIT, initRUM, type RUM, type RUMOptions } from "../src/index";
import { stubFetch, wait } from "./helpers/otlp";

const BASE = "http://localhost:8097";
const { captured, logRecords } = stubFetch(BASE);
const stubbedFetch = globalThis.fetch;

/** Every BroadcastChannel the SDK opens, and whether it was closed. */
const channels: Array<{ name: string; closed: boolean }> = [];
class FakeChannel extends EventTarget {
  private readonly entry: { name: string; closed: boolean };
  constructor(name: string) {
    super();
    this.entry = { name, closed: false };
    channels.push(this.entry);
  }
  postMessage(): void {}
  close(): void {
    this.entry.closed = true;
  }
}

const options = (extra: Partial<RUMOptions> = {}): RUMOptions => ({
  endpoint: BASE,
  projectId: "web-store",
  projectToken: "pt_test_consent",
  service: { name: "web-store", version: "1.0.0", environment: "test" },
  tracing: { documentLoad: false },
  replay: { enabled: false },
  ...extra,
});

/** The SDK's keys; `ouo.demo.user_id` is an app's own key (examples/ouo-web) and must survive a wipe. */
const ouoKeys = (): string[] => Object.keys(localStorage).filter((k) => k.startsWith("ouo.") && k !== "ouo.demo.user_id");
const databases = async (): Promise<string[]> => (await indexedDB.databases()).map((d) => d.name ?? "");

let rum: RUM | undefined;
const realChannel = globalThis.BroadcastChannel;

beforeEach(async () => {
  localStorage.clear();
  for (const name of await databases()) indexedDB.deleteDatabase(name);
  captured.length = 0;
  channels.length = 0;
  globalThis.fetch = stubbedFetch;
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
});

afterEach(async () => {
  await rum?.shutdown();
  rum = undefined;
  globalThis.BroadcastChannel = realChannel;
});

describe("consent pending", () => {
  it("stores nothing, opens nothing, sends nothing and creates no session", async () => {
    const storage = [vi.spyOn(Storage.prototype, "setItem"), vi.spyOn(Storage.prototype, "getItem"), vi.spyOn(Storage.prototype, "removeItem")];
    const idbOpen = vi.spyOn(indexedDB, "open");
    const idbDelete = vi.spyOn(indexedDB, "deleteDatabase");
    const cookie = vi.spyOn(document, "cookie", "set");
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });

    rum = initRUM(options({ consent: "pending", replay: { enabled: true }, transport: { beacon: true } }));
    rum.setUser({ id: "u-1" });
    rum.addEvent("cart.add", { sku: "a" });
    rum.captureError(new Error("before consent"));
    rum.setRoute("/products/:id");
    rum.endSession();
    rum.replay.resume();
    await rum.flush();
    // The app's own traffic, a click, a page hide: nothing of the SDK reacts.
    await fetch("http://localhost:8097/api/products");
    document.body.click();
    globalThis.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(1500); // past the delivery's first drain (1 s) and a log batch (1 s)

    expect(rum.getConsent()).toEqual({ status: "pending", telemetry: false, replay: false });
    expect(rum.session.id()).toBe("");
    expect(rum.session.deviceId()).toBe("");
    expect(rum.replay.isRecording()).toBe(false);
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    expect(ouoKeys()).toEqual([]);
    expect(idbOpen).not.toHaveBeenCalled();
    expect(idbDelete).not.toHaveBeenCalled();
    expect(await databases()).toEqual([]);
    expect(cookie).not.toHaveBeenCalled();
    expect(channels).toEqual([]);
    expect(beacon).not.toHaveBeenCalled();
    // fetch is not even instrumented: the only request is the app's own.
    expect(globalThis.fetch).toBe(stubbedFetch);
    expect(captured.map((c) => c.url)).toEqual(["http://localhost:8097/api/products"]);
  });

  it("starts the session at the grant and runs the queued calls in order", async () => {
    rum = initRUM(options({ consent: "pending" }));
    rum.addEvent("before.user");
    rum.setUser({ id: "u-1" });
    rum.captureError(new Error("before consent"));
    rum.setRoute("/checkout");
    rum.addEvent("cart.add", { sku: "a" });
    expect(ouoKeys()).toEqual([]);

    await rum.setConsent({ telemetry: true, replay: false });
    expect(rum.getConsent()).toEqual({ status: "granted", telemetry: true, replay: false });
    expect(rum.session.id()).not.toBe("");
    expect(rum.session.userId()).toBe("u-1");
    expect(ouoKeys().sort()).toEqual(["ouo.device", "ouo.session", "ouo.user"]);
    rum.addEvent("after.grant");
    await rum.flush();

    const records = logRecords();
    // `navigation`: the page view, emitted at install.
    expect(records.map((r) => r.eventName)).toEqual(["session.start", "navigation", "before.user", "exception", "cart.add", "after.grant"]);
    const id = rum.session.id();
    expect(records.every((r) => r.attributes["session.id"] === id)).toBe(true);
    // Applied in order: the event before setUser is anonymous, the ones after carry the user and the route.
    expect(records[2]!.attributes["user.id"]).not.toBe("u-1");
    expect(records[3]!.attributes["exception.message"]).toBe("before consent");
    expect(records[4]!.attributes["user.id"]).toBe("u-1");
    expect(records[4]!.attributes["app.screen.name"]).toBe("/checkout");
  });

  it("keeps at most CONSENT_QUEUE_LIMIT calls, dropping the oldest", async () => {
    rum = initRUM(options({ consent: "pending" }));
    for (let i = 0; i < CONSENT_QUEUE_LIMIT + 50; i++) rum.addEvent("queued", { i });
    await rum.setConsent({ telemetry: true, replay: false });
    await rum.flush();
    const queued = logRecords().filter((r) => r.eventName === "queued");
    expect(queued).toHaveLength(CONSENT_QUEUE_LIMIT);
    expect(queued[0]!.attributes["i"]).toBe(50);
    expect(queued.at(-1)!.attributes["i"]).toBe(CONSENT_QUEUE_LIMIT + 49);
  });

  it("refused: drops the queue and wipes what an earlier visit stored", async () => {
    localStorage.setItem("ouo.device", JSON.stringify({ id: "from-last-visit" }));
    localStorage.setItem("app.theme", "dark");
    localStorage.setItem("ouo.demo.user_id", "u-7");
    rum = initRUM(options({ consent: "pending" }));
    rum.addEvent("queued");
    await rum.setConsent({ telemetry: false, replay: true });
    expect(rum.getConsent()).toEqual({ status: "denied", telemetry: false, replay: false });
    expect(ouoKeys()).toEqual([]);
    expect(localStorage.getItem("app.theme")).toBe("dark");
    expect(localStorage.getItem("ouo.demo.user_id")).toBe("u-7");
    rum.addEvent("after.refusal");
    await rum.setConsent({ telemetry: true, replay: false });
    await rum.flush();
    expect(logRecords().map((r) => r.eventName)).toEqual(["session.start", "navigation"]);
  });
});

describe("consent revoked", () => {
  it("stops export at once, removes the stored ids and the outbox, closes the channels; a new grant is a new session", async () => {
    rum = initRUM(options({ replay: { enabled: true, sampleRate: 0 } }));
    const device = rum.session.deviceId();
    const session = rum.session.id();
    rum.addEvent("sent");
    await rum.flush();
    await vi.waitFor(async () => expect(await databases()).toContain("ouo-delivery"));
    expect(ouoKeys().length).toBeGreaterThan(0);
    expect(channels.length).toBeGreaterThan(0);

    const before = captured.length;
    rum.addEvent("buffered.at.revoke"); // in the batch queue, not exported yet
    const idbOpen = vi.spyOn(indexedDB, "open");
    await rum.setConsent({ telemetry: false, replay: false });

    expect(rum.getConsent()).toEqual({ status: "denied", telemetry: false, replay: false });
    expect(captured.length).toBe(before);
    expect(ouoKeys()).toEqual([]);
    expect(await databases()).not.toContain("ouo-delivery");
    expect(idbOpen).not.toHaveBeenCalled();
    expect(channels.every((c) => c.closed)).toBe(true);
    expect(rum.session.id()).toBe("");

    // The app's own request goes out untraced: no traceparent, no span, no export.
    await fetch("http://localhost:8097/api/after-revoke");
    rum.addEvent("after.revoke");
    await rum.flush();
    await wait(1200);
    expect(captured.slice(before).map((c) => c.url)).toEqual(["http://localhost:8097/api/after-revoke"]);
    expect(captured.at(-1)!.headers["traceparent"]).toBeUndefined();
    expect(ouoKeys()).toEqual([]);

    await rum.setConsent({ telemetry: true, replay: false });
    expect(rum.session.id()).not.toBe("");
    expect(rum.session.id()).not.toBe(session);
    expect(rum.session.deviceId()).not.toBe(device);
    await rum.flush();
    const names = logRecords().map((r) => r.eventName);
    expect(names).toEqual(["session.start", "navigation", "sent", "session.start", "navigation"]);
  });

  it("a grant right after a revocation waits for the wipe, so the new ids survive it", async () => {
    rum = initRUM(options());
    void rum.setConsent({ telemetry: false, replay: false });
    rum.addEvent("dropped");
    const granted = rum.setConsent({ telemetry: true, replay: false });
    rum.addEvent("queued.during.wipe");
    await granted;
    expect(rum.session.id()).not.toBe("");
    expect(ouoKeys().sort()).toEqual(["ouo.device", "ouo.session", "ouo.user"]);
    await rum.flush();
    // The first instance's records were still in its batch queue at the revocation: dropped.
    expect(logRecords().map((r) => r.eventName)).toEqual(["session.start", "navigation", "queued.during.wipe"]);
  });
});

describe("other tabs", () => {
  it("a revocation in another tab (ouo.device removed) stops this one without writing the ids back", async () => {
    rum = initRUM(options());
    const session = rum.session.id();
    await rum.flush();
    const sent = captured.length;
    rum.addEvent("batched.here");
    // What the other tab's wipe looks like from here: storage events never reach the tab that wrote.
    const device = localStorage.getItem("ouo.device");
    localStorage.removeItem("ouo.device");
    localStorage.removeItem("ouo.session");
    localStorage.removeItem("ouo.user");
    globalThis.dispatchEvent(new StorageEvent("storage", { key: "ouo.device", oldValue: device, newValue: null }));
    await vi.waitFor(() => expect(rum!.getConsent().status).toBe("denied"));
    await rum.flush();
    await wait(1200);
    expect(captured.length).toBe(sent);
    expect(ouoKeys()).toEqual([]);
    expect(rum.session.id()).toBe("");

    // A tab that wrote the old session back before it stopped does not make the next grant resume it.
    localStorage.setItem("ouo.session", JSON.stringify({ id: session, startedAt: Date.now(), lastActivity: Date.now(), replaySeq: 0 }));
    await rum.setConsent({ telemetry: true, replay: false });
    expect(rum.session.id()).not.toBe("");
    expect(rum.session.id()).not.toBe(session);
  });

  it("a key removed by the app, or localStorage.clear(), is not a revocation", async () => {
    rum = initRUM(options());
    globalThis.dispatchEvent(new StorageEvent("storage", { key: null }));
    globalThis.dispatchEvent(new StorageEvent("storage", { key: "ouo.demo.user_id", oldValue: "u", newValue: null }));
    await wait(50);
    expect(rum.getConsent().status).toBe("granted");
  });
});

describe("a grant whose start fails", () => {
  it("leaves the SDK off and drops later calls instead of queuing them", async () => {
    rum = initRUM(options({ consent: "pending" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const add = vi.spyOn(globalThis, "addEventListener").mockImplementation(() => {
      throw new Error("no listeners here");
    });
    await rum.setConsent({ telemetry: true, replay: false });
    add.mockRestore();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not start"), expect.anything());
    rum.addEvent("dropped");
    expect(rum.session.id()).toBe("");
    await rum.flush();
    expect(captured).toEqual([]);
  });
});

describe("replay consent", () => {
  const replay = { enabled: true, sampleRate: 1, flushIntervalMs: 100 };
  const chunks = (): number => captured.filter((c) => c.url === `${BASE}/v1/replay/chunks`).length;

  it("telemetry without replay never loads the recorder; replay granted later starts it", async () => {
    rum = initRUM(options({ consent: "pending", replay }));
    await rum.setConsent({ telemetry: true, replay: false });
    rum.replay.resume(); // the app's resume does not override consent
    await wait(500);
    expect(rum.replay.isRecording()).toBe(false);
    await rum.flush();
    expect(chunks()).toBe(0);

    await rum.setConsent({ telemetry: true, replay: true });
    expect(rum.getConsent().replay).toBe(true);
    await vi.waitFor(() => expect(rum!.replay.isRecording()).toBe(true), { timeout: 5000 });
    await rum.flush();
    expect(chunks()).toBeGreaterThan(0);
  });

  it("withdrawing replay alone stops the recorder and keeps the session", async () => {
    rum = initRUM(options({ replay }));
    await vi.waitFor(() => expect(rum!.replay.isRecording()).toBe(true), { timeout: 5000 });
    const session = rum.session.id();
    await rum.setConsent({ telemetry: true, replay: false });
    expect(rum.replay.isRecording()).toBe(false);
    expect(rum.session.id()).toBe(session);
    await rum.flush();
    const after = chunks();
    document.body.appendChild(document.createElement("p")).textContent = "not recorded";
    await wait(300);
    await rum.flush();
    expect(chunks()).toBe(after);
    rum.addEvent("still.sent");
    await rum.flush();
    expect(logRecords().some((r) => r.eventName === "still.sent")).toBe(true);
  });

  it("replay without telemetry means nothing", async () => {
    rum = initRUM(options({ consent: "pending", replay }));
    await rum.setConsent({ telemetry: false, replay: true });
    expect(rum.getConsent()).toEqual({ status: "denied", telemetry: false, replay: false });
    expect(rum.replay.isRecording()).toBe(false);
    expect(captured).toEqual([]);
  });
});

describe("default: consent granted", () => {
  it("an app that never mentions consent starts at once, replay included", async () => {
    rum = initRUM(options({ replay: { enabled: true, sampleRate: 1 } }));
    expect(rum.getConsent()).toEqual({ status: "granted", telemetry: true, replay: true });
    expect(rum.session.id()).not.toBe("");
    expect(ouoKeys().sort()).toEqual(["ouo.device", "ouo.session", "ouo.user"]);
    await vi.waitFor(() => expect(rum!.replay.isRecording()).toBe(true), { timeout: 5000 });
    await rum.flush();
    expect(logRecords()[0]!.eventName).toBe("session.start");
  });
});
