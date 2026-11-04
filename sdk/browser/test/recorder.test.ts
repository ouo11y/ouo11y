import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake rrweb: record() hands back an emitter the test drives.
const rr = vi.hoisted(() => ({
  emit: null as ((e: unknown, isCheckout?: boolean) => void) | null,
  starts: 0,
  stops: 0,
  custom: [] as Array<{ tag: string; payload: unknown }>,
}));
vi.mock("rrweb", () => {
  const record = (opts: { emit: (e: unknown, c?: boolean) => void }) => {
    rr.starts++;
    rr.emit = opts.emit;
    opts.emit({ type: 4, timestamp: Date.now() });
    opts.emit({ type: 2, timestamp: Date.now() });
    return () => {
      rr.stops++;
      rr.emit = null;
    };
  };
  record.addCustomEvent = (tag: string, payload: unknown) => rr.custom.push({ tag, payload });
  record.takeFullSnapshot = () => undefined;
  return { record };
});

import { HIDDEN_EVENT_TAG, ReplayRecorder, SHOW_DELAY_MS, type RecorderOptions } from "../src/replay/recorder";
import { TabLease } from "../src/replay/tabs";
import { SessionManager } from "../src/session/manager";
import { MemoryStorage } from "../src/session/storage";

const logger = { enabled: false, log: () => undefined, warn: () => undefined };

function setup(
  opts: { sampleRate: number; onErrorSampleRate: number; channel?: BroadcastChannel | null; maxSnapshotBytes?: number; onSkip?: (r: string, b: number) => void } & Pick<
    RecorderOptions,
    "privacy" | "onHidden"
  >,
) {
  const session = new SessionManager({ storage: new MemoryStorage(), onEvent: () => undefined });
  session.start();
  const pushed: Array<{ type: number }> = [];
  const chunker = { push: (e: { type: number }) => pushed.push(e), flush: vi.fn(async () => undefined) };
  const lease = new TabLease(opts.channel ?? null);
  const recorder = new ReplayRecorder({
    enabled: true,
    sampleRate: opts.sampleRate,
    onErrorSampleRate: opts.onErrorSampleRate,
    session,
    chunker: chunker as never,
    logger,
    lease,
    ...(opts.maxSnapshotBytes !== undefined ? { maxSnapshotBytes: opts.maxSnapshotBytes } : {}),
    ...(opts.onSkip ? { onSkip: opts.onSkip } : {}),
    privacy: opts.privacy,
    ...(opts.onHidden ? { onHidden: opts.onHidden } : {}),
  });
  return { session, pushed, chunker, recorder, lease };
}

const ev = (type: number) => ({ type, timestamp: Date.now() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ReplayRecorder modes", () => {
  beforeEach(() => {
    rr.starts = rr.stops = 0;
    rr.custom = [];
  });

  it("full mode uploads every event and marks the tab", async () => {
    const { pushed, recorder, lease } = setup({ sampleRate: 1, onErrorSampleRate: 0 });
    await recorder.start();
    expect(recorder.currentMode()).toBe("full");
    rr.emit!(ev(3));
    expect(pushed.map((e) => e.type)).toEqual([4, 2, 3]);
    expect(rr.custom).toEqual([{ tag: "ouo.tab", payload: { tab_id: lease.tabId, url: location.href } }]);
    recorder.shutdown();
  });

  it("off when neither rate samples the session", async () => {
    const { pushed, recorder } = setup({ sampleRate: 0, onErrorSampleRate: 0 });
    await recorder.start();
    expect(recorder.currentMode()).toBe("off");
    expect(recorder.isRecording()).toBe(false);
    expect(pushed).toHaveLength(0);
  });

  it("buffer mode keeps the last two checkouts in memory and uploads them on the first error", async () => {
    const { session, pushed, recorder } = setup({ sampleRate: 0, onErrorSampleRate: 1 });
    await recorder.start();
    expect(recorder.currentMode()).toBe("buffer");
    rr.emit!(ev(3));
    // Two checkouts: the first (initial) snapshot falls out of the buffer.
    rr.emit!({ type: 4, timestamp: 1 }, true);
    rr.emit!({ type: 2, timestamp: 2 }, true);
    rr.emit!(ev(3));
    rr.emit!({ type: 4, timestamp: 3 }, true);
    rr.emit!({ type: 2, timestamp: 4 }, true);
    rr.emit!(ev(3));
    expect(pushed).toHaveLength(0);

    recorder.onError();
    expect(recorder.currentMode()).toBe("full");
    expect(session.replayTriggered()).toBe(true);
    // The buffer from the second-to-last checkout on, then a fresh recording in full mode.
    expect(pushed.map((e) => e.type)).toEqual([4, 2, 3, 4, 2, 3, 4, 2]);
    expect(rr.starts).toBe(2);
    rr.emit!(ev(3));
    expect(pushed).toHaveLength(9);
    recorder.shutdown();
  });

  it("a reload of a triggered session records in full mode", async () => {
    const { session, recorder } = setup({ sampleRate: 0, onErrorSampleRate: 1 });
    session.triggerReplay();
    await recorder.start();
    expect(recorder.currentMode()).toBe("full");
    recorder.shutdown();
  });

  it("a full snapshot too large to upload stops replay for the page view instead of sending mutations", async () => {
    const skipped: Array<[string, number]> = [];
    const { pushed, recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, maxSnapshotBytes: 10, onSkip: (r, b) => skipped.push([r, b]) });
    await recorder.start();
    expect(recorder.isRecording()).toBe(false);
    expect(rr.stops).toBe(1);
    expect(pushed.map((e) => e.type)).toEqual([4]);
    expect(skipped).toEqual([["snapshot_too_large", expect.any(Number)]]);
    // Not restarted by focus or resume.
    recorder.resume();
    await Promise.resolve();
    expect(rr.starts).toBe(1);
    recorder.shutdown();
  });

  it("errors in full mode change nothing", async () => {
    const { recorder } = setup({ sampleRate: 1, onErrorSampleRate: 1 });
    await recorder.start();
    recorder.onError();
    expect(rr.starts).toBe(1);
    recorder.shutdown();
  });
});

describe("multi-tab replay", () => {
  it("a tab stops recording when another tab of the session claims the lease, and resumes on interaction", async () => {
    const name = `ouo.replay.test.${Math.random()}`;
    const a = setup({ sampleRate: 1, onErrorSampleRate: 0, channel: new BroadcastChannel(name) });
    await a.recorder.start();
    expect(a.recorder.isRecording()).toBe(true);

    // Another tab (its own channel instance on the same name) claims the lease.
    const other = new TabLease(new BroadcastChannel(name));
    other.claim(a.session.id());
    await vi.waitFor(() => expect(a.recorder.isRecording()).toBe(false));
    expect(a.lease.isOwner()).toBe(false);
    expect(a.chunker.flush).toHaveBeenCalled();

    // The user comes back to the first tab: it claims again and starts with a full snapshot.
    const heard = vi.fn();
    other.onLost(heard);
    window.dispatchEvent(new Event("pointerdown"));
    expect(a.recorder.isRecording()).toBe(true);
    expect(a.pushed.at(-1)!.type).toBe(2);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith(a.session.id()));
    a.recorder.shutdown();
    other.close();
  });

  it("a claim for another session is ignored", async () => {
    const name = `ouo.replay.test.${Math.random()}`;
    const a = setup({ sampleRate: 1, onErrorSampleRate: 0, channel: new BroadcastChannel(name) });
    await a.recorder.start();
    const other = new TabLease(new BroadcastChannel(name));
    other.claim("another-session");
    await new Promise((r) => setTimeout(r, 20));
    expect(a.recorder.isRecording()).toBe(true);
    a.recorder.shutdown();
    other.close();
  });

  it("a hidden tab stops recording", async () => {
    const a = setup({ sampleRate: 1, onErrorSampleRate: 0 });
    await a.recorder.start();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(a.recorder.isRecording()).toBe(false);
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(a.recorder.isRecording()).toBe(true);
    a.recorder.shutdown();
  });
});

describe("never-record routes", () => {
  type Pushed = Array<{ type: number; data?: { tag?: string } }>;
  const go = (path: string) => history.replaceState(null, "", path);
  const markers = (pushed: Pushed) => pushed.filter((e) => e.type === 5 && e.data?.tag === HIDDEN_EVENT_TAG);
  beforeEach(() => {
    rr.starts = rr.stops = 0;
    go("/");
  });

  it("starting on an excluded route records nothing and writes one marker until the route is left", async () => {
    go("/patients/42");
    const onHidden = vi.fn();
    const { pushed, recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, privacy: { excludeRoutes: ["/patients/*"] }, onHidden });
    await recorder.start();
    expect(rr.starts).toBe(0);
    expect(recorder.isRecording()).toBe(false);
    expect(pushed).toEqual([expect.objectContaining({ type: 5, data: { tag: HIDDEN_EVENT_TAG, payload: { reason: "route" } } })]);
    // Interaction and another hidden route neither start it nor mark again.
    globalThis.dispatchEvent(new Event("pointerdown"));
    go("/patients/43");
    recorder.onRoute();
    expect(rr.starts).toBe(0);
    expect(onHidden).toHaveBeenCalledTimes(1);
    // Leaving: nothing for SHOW_DELAY_MS (the router renders the next page after the URL changed),
    // not even on interaction; then a fresh recording, starting with its full snapshot.
    go("/home");
    recorder.onRoute();
    globalThis.dispatchEvent(new Event("pointerdown"));
    expect(rr.starts).toBe(0);
    await wait(SHOW_DELAY_MS + 20);
    expect(rr.starts).toBe(1);
    expect(pushed.slice(1).map((e) => e.type)).toEqual([4, 2]);
    recorder.shutdown();
  });

  it("going back to a hidden route before the restart keeps it hidden", async () => {
    go("/patients/1");
    const { recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, privacy: { excludeRoutes: ["/patients/*"] } });
    await recorder.start();
    go("/home");
    recorder.onRoute();
    go("/patients/2");
    recorder.onRoute();
    await wait(SHOW_DELAY_MS + 20);
    expect(rr.starts).toBe(0);
    recorder.shutdown();
  });

  it("entering an excluded route marks the replay, then stops and flushes", async () => {
    const { pushed, chunker, recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, privacy: { excludeRoutes: [/^\/sign/] } });
    await recorder.start();
    go("/home/2");
    recorder.onRoute();
    expect(recorder.isRecording()).toBe(true);
    chunker.flush.mockClear();
    go("/sign/1");
    recorder.onRoute();
    expect(recorder.isRecording()).toBe(false);
    expect(rr.stops).toBe(1);
    expect(pushed.at(-1)).toMatchObject({ type: 5, data: { tag: HIDDEN_EVENT_TAG } });
    expect(chunker.flush).toHaveBeenCalled();
    // A second stretch of the same session gets its own marker.
    go("/home");
    recorder.onRoute();
    await wait(SHOW_DELAY_MS + 20);
    expect(recorder.isRecording()).toBe(true);
    go("/sign/2");
    recorder.onRoute();
    expect(markers(pushed as Pushed)).toHaveLength(2);
    recorder.shutdown();
  });

  it("drops an event rrweb hands over after the URL moved to an excluded route, before onRoute runs", async () => {
    // A router's popstate listener registered before the SDK's renders first; the microtask
    // checkpoint between listeners lets rrweb emit the new page before the SDK hears of it.
    const { pushed, recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, privacy: { excludeRoutes: ["/patients/*"] } });
    await recorder.start();
    const before = pushed.length;
    go("/patients/9");
    rr.emit!({ type: 3, timestamp: Date.now(), data: { source: 0, adds: [{ node: { type: 3, id: 99, textContent: "SECRETPOP" } }] } });
    expect(JSON.stringify(pushed)).not.toContain("SECRETPOP");
    expect(pushed.slice(before)).toEqual([expect.objectContaining({ type: 5, data: { tag: HIDDEN_EVENT_TAG, payload: { reason: "route" } } })]);
    expect(recorder.isRecording()).toBe(false);
    recorder.onRoute();
    expect(markers(pushed as Pushed)).toHaveLength(1);
    recorder.shutdown();
  });

  it("resume, visibility and a new session on a hidden route keep it hidden; the new session gets its own marker", async () => {
    go("/patients");
    const { session, pushed, recorder } = setup({ sampleRate: 1, onErrorSampleRate: 0, privacy: { excludeRoutes: ["/patients"] } });
    await recorder.start();
    recorder.pause();
    recorder.resume();
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rr.starts).toBe(0);
    expect(markers(pushed as Pushed)).toHaveLength(1);
    const before = session.id();
    session.endSession();
    expect(session.id()).not.toBe(before);
    recorder.onRotate(session.peek()!, before);
    await Promise.resolve();
    expect(markers(pushed as Pushed)).toHaveLength(2);
    expect(rr.starts).toBe(0);
    recorder.shutdown();
  });
});
