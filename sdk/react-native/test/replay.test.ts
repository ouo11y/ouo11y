import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger";
import { _setExpoModulesCore, createReplayController, loadNativeReplayModule, screenExcluded, type NativeReplayModule } from "../src/replay";
import { MemoryAsyncStorage } from "../src/session/storage";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { AppState } from "./mocks/react-native";
import * as expoModulesCoreMock from "./mocks/expo-modules-core";

const { nativeReplay, resetNative, setNativeAvailable } = expoModulesCoreMock;
// The SDK reaches expo-modules-core through a bare require (Metro resolves it); point it at the mock here.
_setExpoModulesCore(() => expoModulesCoreMock);

const ENDPOINT = "http://otel.test:4318";
const REPLAY_ENDPOINT = "http://otel.test:4319";
const PROJECT_ID = "demo";
const TOKEN = "pt_test_token_0000000000000000";

function fakeNative() {
  const state = { recording: false };
  const n = {
    get recording() {
      return state.recording;
    },
    start: vi.fn((_endpoint: string, _options: unknown) => {
      state.recording = true;
    }),
    pause: vi.fn(() => {
      state.recording = false;
    }),
    resume: vi.fn(() => {
      state.recording = true;
    }),
    isRecording: vi.fn(() => state.recording),
    flush: vi.fn(() => Promise.resolve()),
    sessionDidRotate: vi.fn((_id: string) => undefined),
    setSessionId: vi.fn((_id: string) => undefined),
    screenDidChange: vi.fn(),
    recoverPendingChunk: vi.fn((_endpoint: string, _options: unknown) => undefined),
    stop: vi.fn(),
  } satisfies NativeReplayModule & { recording: boolean };
  return n;
}

describe("replay controller", () => {
  const logger = createLogger(false);

  it("starts the native recorder with the endpoint, session id and option defaults", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    expect(c.active).toBe(false);
    c.start("sess-1");
    expect(native.setSessionId).toHaveBeenCalledWith("sess-1");
    expect(native.start).toHaveBeenCalledWith("http://localhost:8080", {
      sessionId: "sess-1",
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      mode: "auto",
      frameInterval: 1,
      maskText: true,
      maskInputs: true,
      maskImages: true,
      maskWebViews: true,
      debug: false,
      holdUploads: false,
    });
    expect(c.active).toBe(true);
    expect(c.isRecording()).toBe(true);
    // A second start is ignored.
    c.start("sess-2");
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it("passes explicit options through", () => {
    const native = fakeNative();
    const c = createReplayController({
      endpoint: "http://localhost:8080",
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      options: { enabled: true, mode: "navigation", frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false },
      native,
      logger: createLogger(true),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    c.start("s");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ mode: "navigation", frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false, debug: true });
  });

  // The spool of a crashed session must go out even when the next session is not recorded.
  it("recovers the previous run's open chunk before any sampling decision", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, sampleRate: 0 }, native, logger });
    expect(native.recoverPendingChunk).toHaveBeenCalledTimes(1);
    expect(native.recoverPendingChunk).toHaveBeenCalledWith("http://localhost:8080", expect.objectContaining({ projectId: PROJECT_ID, projectToken: TOKEN }));
    c.start("not-recorded");
    expect(native.start).not.toHaveBeenCalled();
    const off = fakeNative();
    createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: false }, native: off, logger });
    expect(off.recoverPendingChunk).not.toHaveBeenCalled();
  });

  it("screen changes reach the native recorder while it records; older native builds without the call are fine", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.screenDidChange();
    expect(native.screenDidChange).not.toHaveBeenCalled();
    c.start("s");
    c.screenDidChange();
    expect(native.screenDidChange).toHaveBeenCalledTimes(1);
    const { screenDidChange: _gone, ...older } = fakeNative();
    const c2 = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native: older, logger });
    c2.start("s");
    expect(() => c2.screenDidChange()).not.toThrow();
  });

  it("maskText: false keeps inputs masked (maskInputs defaults to true on its own)", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, maskText: false }, native, logger });
    c.start("s");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ maskText: false, maskInputs: true, maskImages: true, maskWebViews: true });
    const c2 = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, maskInputs: false }, native: fakeNative(), logger });
    c2.start("s");
    expect(c2.active).toBe(true);
  });

  it("pause / resume / isRecording delegate to the native module", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.start("s");
    c.pause();
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(c.isRecording()).toBe(false);
    c.resume();
    expect(native.resume).toHaveBeenCalledTimes(1);
    expect(c.isRecording()).toBe(true);
  });

  it("forwards rotations once per new id and ignores the current id", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.start("a");
    c.sessionDidRotate("a");
    expect(native.sessionDidRotate).not.toHaveBeenCalled();
    c.sessionDidRotate("b");
    c.sessionDidRotate("b");
    expect(native.sessionDidRotate).toHaveBeenCalledTimes(1);
    expect(native.sessionDidRotate).toHaveBeenCalledWith("b");
  });

  it("flush awaits the native flush and stop releases the recorder", async () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.start("s");
    await c.flush();
    expect(native.flush).toHaveBeenCalledTimes(1);
    c.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(c.active).toBe(false);
    expect(c.isRecording()).toBe(false);
    c.pause();
    expect(native.pause).not.toHaveBeenCalled();
  });

  it("is a no-op when replay is not enabled, even with a native module present", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: undefined, native, logger });
    c.start("s");
    c.pause();
    c.resume();
    c.sessionDidRotate("t");
    expect(c.active).toBe(false);
    expect(c.isRecording()).toBe(false);
    expect(native.start).not.toHaveBeenCalled();
    expect(native.setSessionId).not.toHaveBeenCalled();
  });

  it("is safe when the native module is absent and warns once in debug", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native: null, logger: createLogger(true) });
    c.start("s");
    c.pause();
    c.resume();
    c.sessionDidRotate("t");
    await c.flush();
    c.stop();
    expect(c.isRecording()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain("OuoReplay unavailable");
  });

  it("survives a throwing native module", () => {
    const native = fakeNative();
    native.start.mockImplementation(() => {
      throw new Error("boom");
    });
    const c = createReplayController({ endpoint: "http://localhost:8080", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    expect(() => c.start("s")).not.toThrow();
    expect(c.active).toBe(false);
  });

  it("does not start without an endpoint", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: undefined, projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.start("s");
    expect(native.start).not.toHaveBeenCalled();
  });
});

describe("never-record screens (excludeScreens, hideScreen)", () => {
  const logger = createLogger(false);
  const setup = (excludeScreens?: Array<string | RegExp>) => {
    const native = fakeNative();
    const onHidden = vi.fn();
    const c = createReplayController({ endpoint: REPLAY_ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, ...(excludeScreens ? { excludeScreens } : {}) }, native, onHidden, logger });
    c.start("sess-1");
    return { native, onHidden, c };
  };

  it("matches screen names and paths exactly, by `*` prefix and by RegExp", () => {
    const patterns = ["IdentityCheck", "/Account/Sign*", /^Patient/g];
    expect(screenExcluded(patterns, "/Account/IdentityCheck")).toBe(true);
    expect(screenExcluded(patterns, "/Account/SignatureStep")).toBe(true);
    expect(screenExcluded(patterns, "/Home/PatientDetail")).toBe(true);
    expect(screenExcluded(patterns, "/Home/PatientDetail")).toBe(true);
    expect(screenExcluded(patterns, "/Home/IdentityCheckIntro")).toBe(false);
    expect(screenExcluded(patterns, "/Home")).toBe(false);
    expect(screenExcluded(undefined, "/Account/IdentityCheck")).toBe(false);
  });

  it("pauses capture on an excluded screen, marks it once and resumes on leaving it", () => {
    const { native, onHidden, c } = setup(["IdentityCheck"]);
    c.setScreen("/Home");
    expect(native.pause).not.toHaveBeenCalled();
    c.setScreen("/Account/IdentityCheck");
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledWith("screen");
    // No frame is asked for on the hidden screen.
    c.screenDidChange();
    expect(native.screenDidChange).not.toHaveBeenCalled();
    c.setScreen("/Account/IdentityCheck");
    expect(onHidden).toHaveBeenCalledTimes(1);
    c.setScreen("/Home");
    expect(native.resume).toHaveBeenCalledTimes(1);
    c.screenDidChange();
    expect(native.screenDidChange).toHaveBeenCalledTimes(1);
  });

  it("hideScreen and showScreen stack with excludeScreens and the host's pause", () => {
    const { native, onHidden, c } = setup(["Sign"]);
    c.hideScreen();
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenLastCalledWith("manual");
    // Still hidden by hideScreen: neither leaving an excluded screen nor the host's resume records.
    c.setScreen("/Sign");
    c.setScreen("/Home");
    c.pause();
    c.resume();
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.pause).toHaveBeenCalledTimes(1);
    c.showScreen();
    expect(native.resume).toHaveBeenCalledTimes(1);
    // The host paused: showScreen leaves it paused.
    c.pause();
    c.hideScreen();
    c.showScreen();
    expect(native.resume).toHaveBeenCalledTimes(1);
    c.resume();
    expect(native.resume).toHaveBeenCalledTimes(2);
  });

  it("a recorder started or a session rotated on a hidden screen stays paused and marks the new session", () => {
    const native = fakeNative();
    const onHidden = vi.fn();
    const c = createReplayController({ endpoint: REPLAY_ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, onHidden, logger });
    c.hideScreen();
    expect(onHidden).not.toHaveBeenCalled();
    c.start("sess-1");
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
    c.sessionDidRotate("sess-2");
    expect(native.resume).not.toHaveBeenCalled();
    expect(onHidden).toHaveBeenCalledTimes(2);
    c.onError();
    expect(native.resume).not.toHaveBeenCalled();
  });
});

describe("loadNativeReplayModule (expo-modules-core)", () => {
  afterEach(() => resetNative());

  it("returns the module when expo-modules-core exposes it", () => {
    expect(loadNativeReplayModule()).toBe(nativeReplay);
  });

  it("returns undefined when requireNativeModule throws (Expo Go, web)", () => {
    setNativeAvailable(false);
    expect(loadNativeReplayModule()).toBeUndefined();
  });
});

describe("initRUM({ replay })", () => {
  const g = globalThis as { __ouoSessionProcessState?: unknown };
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    delete g.__ouoSessionProcessState;
    resetNative();
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.__ouoSessionProcessState;
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    endpoint: ENDPOINT,
    projectId: PROJECT_ID,
    projectToken: TOKEN,
    service: { name: "mobile-store", version: "2.3.0", environment: "test" },
    storage: new MemoryAsyncStorage(),
    ...extra,
  });

  it("starts the native recorder with the derived replay endpoint (4318 -> 4319), the credential and the session id", async () => {
    const rum = initRUM(options({ replay: { enabled: true } })) as RUMInternal;
    expect(nativeReplay.setSessionId).toHaveBeenCalledWith(rum.session.id());
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    expect(nativeReplay.start).toHaveBeenCalledWith(REPLAY_ENDPOINT, expect.objectContaining({ sessionId: rum.session.id(), projectId: PROJECT_ID, projectToken: TOKEN, frameInterval: 1 }));
    // Never the revision-1 header or a prebuilt header value: native builds the Basic credential itself.
    expect(Object.keys(nativeReplay.start.mock.calls[0]![1] as object).sort()).toEqual(
      ["debug", "frameInterval", "holdUploads", "maskImages", "maskInputs", "maskText", "maskWebViews", "mode", "projectId", "projectToken", "sessionId"],
    );
    await rum.ready;
    // The cold-start resolution reports the initial session through onRotate: not a rotation.
    expect(nativeReplay.sessionDidRotate).not.toHaveBeenCalled();
    expect(rum.replay.isRecording()).toBe(true);
    rum.replay.pause();
    expect(rum.replay.isRecording()).toBe(false);
    rum.replay.resume();
    expect(rum.replay.isRecording()).toBe(true);
    await rum.flush();
    expect(nativeReplay.flush).toHaveBeenCalled();
    await rum._uninstall();
    expect(nativeReplay.stop).toHaveBeenCalledTimes(1);
  });

  it("uses the endpoint itself when it is not on port 4318, and an explicit replayEndpoint when given", async () => {
    const proxied = initRUM(options({ replay: { enabled: true }, endpoint: "https://otel.example.com/" })) as RUMInternal;
    expect(nativeReplay.start.mock.calls[0]![0]).toBe("https://otel.example.com");
    await proxied._uninstall();
    resetNative();
    delete g.__ouoSessionProcessState;
    initRUM(options({ replay: { enabled: true }, endpoint: "http://otel.test:4318/", replayEndpoint: "http://replay.test:9999/" }));
    expect(nativeReplay.start.mock.calls[0]![0]).toBe("http://replay.test:9999");
  });

  it("tells the native recorder about every session rotation", async () => {
    const rum = initRUM(options({ replay: { enabled: true }, session: { backgroundTimeoutMs: 30 } })) as RUMInternal;
    await rum.ready;
    const first = rum.session.id();
    AppState.__emit("background");
    await new Promise((r) => setTimeout(r, 60));
    AppState.__emit("active");
    const second = rum.session.id();
    expect(second).not.toBe(first);
    expect(nativeReplay.sessionDidRotate).toHaveBeenCalledTimes(1);
    expect(nativeReplay.sessionDidRotate).toHaveBeenCalledWith(second);
  });

  it("leaves the native module alone when replay is off (default)", async () => {
    const rum = initRUM(options()) as RUMInternal;
    await rum.ready;
    expect(nativeReplay.start).not.toHaveBeenCalled();
    expect(nativeReplay.setSessionId).not.toHaveBeenCalled();
    expect(rum.replay.isRecording()).toBe(false);
  });

  it("excludeScreens pauses native capture from the navigation that shows the screen and puts ouo.replay.hidden on the timeline", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const rum = initRUM(options({ replay: { enabled: true, excludeScreens: ["IdentityCheck"] }, transport: { offline: false } })) as RUMInternal;
    await rum.ready;
    rum.trackNavigation("/Home");
    expect(nativeReplay.pause).not.toHaveBeenCalled();
    rum.trackNavigation("/Account/IdentityCheck");
    expect(nativeReplay.pause).toHaveBeenCalledTimes(1);
    rum.trackNavigation("/Home");
    expect(nativeReplay.resume).toHaveBeenCalledTimes(1);
    rum.replay.hideScreen();
    expect(nativeReplay.pause).toHaveBeenCalledTimes(2);
    rum.replay.showScreen();
    expect(nativeReplay.resume).toHaveBeenCalledTimes(2);
    await rum.flush();
    const sent = bodies.join("\n");
    expect(sent).toContain("ouo.replay.hidden");
    expect(sent.match(/"ouo\.replay\.hidden_reason","value":\{"stringValue":"(screen|manual)"/g)?.length).toBe(2);
  });

  it("is a no-op without the native module (Expo Go)", async () => {
    setNativeAvailable(false);
    const rum = initRUM(options({ replay: { enabled: true } })) as RUMInternal;
    await rum.ready;
    expect(rum.replay.isRecording()).toBe(false);
    rum.replay.pause();
    rum.replay.resume();
    await rum.flush();
  });
});

describe("replay.keepAtNextLaunch (next-launch keep/drop)", () => {
  const logger = createLogger(false);
  const held = [
    { sessionId: "prev-crashed", chunks: 3, bytes: 90_000, firstAt: 1000, lastAt: 11_000 },
    { sessionId: "prev-quiet", chunks: 1, bytes: 20_000, firstAt: 20_000, lastAt: 20_000 },
    { sessionId: "current", chunks: 1, bytes: 5_000, firstAt: 30_000, lastAt: 30_000 },
  ];
  const nativeWithHeld = () => {
    const n = { ...fakeNative(), heldReplaySessions: vi.fn(async () => held), releaseHeldReplay: vi.fn() };
    return n;
  };

  it("asks the hook about every finished session and sends or deletes its chunks", async () => {
    const storage = new MemoryAsyncStorage();
    // The previous run counted two errors in prev-quiet.
    await storage.setItem("ouo.replay.errors", JSON.stringify({ "prev-quiet": 2 }));
    const native = nativeWithHeld();
    const seen: unknown[] = [];
    const c = createReplayController({
      endpoint: "http://localhost:4319",
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      options: { enabled: true, keepAtNextLaunch: (s) => (seen.push(s), s.crashed || s.errors > 0 ? true : false) },
      native,
      storage,
      logger,
    });
    c.start("current");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ holdUploads: true });
    await c.decideHeld("current", "prev-crashed");
    expect(seen).toEqual([
      { sessionId: "prev-crashed", chunks: 3, bytes: 90_000, firstChunkAt: 1000, lastChunkAt: 11_000, crashed: true, errors: 0, feedback: 0 },
      { sessionId: "prev-quiet", chunks: 1, bytes: 20_000, firstChunkAt: 20_000, lastChunkAt: 20_000, crashed: false, errors: 2, feedback: 0 },
    ]);
    expect(native.releaseHeldReplay.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["prev-crashed", true],
      ["prev-quiet", true],
    ]);
  });

  it("counts this session's errors for the next launch and forgets decided sessions", async () => {
    const storage = new MemoryAsyncStorage();
    await storage.setItem("ouo.replay.errors", JSON.stringify({ "prev-quiet": 2 }));
    const native = nativeWithHeld();
    const c = createReplayController({ endpoint: "http://localhost:4319", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, keepAtNextLaunch: () => false }, native, storage, logger });
    c.start("current");
    c.onError();
    c.onError();
    await c.decideHeld("current", undefined);
    expect(native.releaseHeldReplay.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["prev-crashed", false],
      ["prev-quiet", false],
    ]);
    expect(JSON.parse(storage.peek("ouo.replay.errors")!)).toEqual({ current: 2 });
  });

  it("counts this session's feedback for the next launch, so the hook can keep the sessions users reported on (C10)", async () => {
    const storage = new MemoryAsyncStorage();
    await storage.setItem("ouo.replay.feedback", JSON.stringify({ "prev-quiet": 1 }));
    const native = nativeWithHeld();
    const seen: Array<{ sessionId: string; feedback: number }> = [];
    const c = createReplayController({
      endpoint: "http://localhost:4319",
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      options: { enabled: true, keepAtNextLaunch: (s) => (seen.push(s), s.feedback > 0) },
      native,
      storage,
      logger,
    });
    c.start("current");
    c.onFeedback();
    await c.decideHeld("current", undefined);
    expect(seen.map((s) => [s.sessionId, s.feedback])).toEqual([
      ["prev-crashed", 0],
      ["prev-quiet", 1],
    ]);
    expect(native.releaseHeldReplay.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["prev-crashed", false],
      ["prev-quiet", true],
    ]);
    expect(JSON.parse(storage.peek("ouo.replay.feedback")!)).toEqual({ current: 1 });
    // Without the hook nothing is counted (nothing is held).
    const s2 = new MemoryAsyncStorage();
    const c2 = createReplayController({ endpoint: "http://localhost:4319", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native: nativeWithHeld(), storage: s2, logger });
    c2.start("current");
    c2.onFeedback();
    await c2.decideHeld("current", undefined);
    expect(s2.peek("ouo.replay.feedback")).toBeNull();
  });

  it("without the hook nothing is held and anything held earlier is sent; a throwing hook keeps", async () => {
    const native = nativeWithHeld();
    const c = createReplayController({ endpoint: "http://localhost:4319", projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, logger });
    c.start("current");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ holdUploads: false });
    await c.decideHeld("current", undefined);
    expect(native.releaseHeldReplay.mock.calls.every((call) => call[3] === true)).toBe(true);

    const n2 = nativeWithHeld();
    const c2 = createReplayController({
      endpoint: "http://localhost:4319",
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      options: {
        enabled: true,
        keepAtNextLaunch: () => {
          throw new Error("hook bug");
        },
      },
      native: n2,
      logger,
    });
    await c2.decideHeld("current", undefined);
    expect(n2.releaseHeldReplay.mock.calls.map((call) => call[3])).toEqual([true, true]);
  });
});
