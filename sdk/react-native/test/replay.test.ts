import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger";
import { guard } from "../src/guard";
import { _setExpoModulesCore, createReplayController, loadNativeReplayModule, nativeTag, NATIVE_REPLAY_MODES, newViewId, REPLAY_MODES, resolveReplayMode, screenExcluded, SHOW_DELAY_MS, type NativeReplayModule } from "../src/replay";
import type { ReplayMode } from "../src/types";
import { MemoryAsyncStorage } from "../src/session/storage";
import { initRUM, type RUMInternal } from "../src/index";
import { SDK_VERSION } from "../src/version";
import { getRUM } from "../src/instance";
import { AppState } from "./mocks/react-native";
import * as expoModulesCoreMock from "./mocks/expo-modules-core";

const { nativeReplay, resetNative, setNativeAvailable } = expoModulesCoreMock;
// The SDK reaches expo-modules-core through a bare require (Metro resolves it); point it at the mock here.
_setExpoModulesCore(() => expoModulesCoreMock);

const ENDPOINT = "http://otel.test:4318";
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
    stop: vi.fn(() => {
      state.recording = false;
    }),
    endSession: vi.fn(() => {
      state.recording = false;
    }),
    capture: vi.fn((_trigger: string) => undefined),
    setViewId: vi.fn((_id: string) => undefined),
    mask: vi.fn((_tag: number) => undefined),
    unmask: vi.fn((_tag: number) => undefined),
    discardPending: vi.fn(() => Promise.resolve()),
    replayDiagnostics: vi.fn(() => ({})),
    // Legacy only: the OTLP path must never call it.
    recoverPendingChunk: vi.fn(),
  } satisfies NativeReplayModule & { recording: boolean; recoverPendingChunk: unknown };
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
      mode: "pixel/frames",
      cadence: "auto",
      frameInterval: 1,
      maskText: true,
      maskInputs: true,
      maskImages: true,
      maskWebViews: true,
      debug: false,
      // The `otlp` key selects the OTLP path in the native module (ADR-0021 decision 5).
      otlp: { logsUrl: "http://localhost:8080/v1/logs", schemaUrl: "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev" },
    });
    expect(native.recoverPendingChunk).not.toHaveBeenCalled();
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
      options: { enabled: true, cadence: "navigation", frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false },
      native,
      logger: createLogger(true),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    c.start("s");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ mode: "pixel/frames", cadence: "navigation", frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false, debug: true });
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
    const c = createReplayController({ endpoint: ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true, ...(excludeScreens ? { excludeScreens } : {}) }, native, onHidden, logger });
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

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pauses capture on an excluded screen, marks it once and resumes SHOW_DELAY_MS after leaving it", () => {
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
    // Leaving: the never-record screen may still be sliding out; nothing until the delay ran out.
    c.setScreen("/Home");
    c.screenDidChange();
    c.resume();
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.screenDidChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(native.resume).toHaveBeenCalledTimes(1);
    c.screenDidChange();
    expect(native.screenDidChange).toHaveBeenCalledTimes(1);
  });

  it("going back to a hidden screen within the delay keeps capture paused, one stretch", () => {
    const { native, onHidden, c } = setup(["IdentityCheck"]);
    c.setScreen("/Account/IdentityCheck");
    c.setScreen("/Home");
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2);
    c.setScreen("/Account/IdentityCheck");
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("hideScreen and showScreen stack with excludeScreens and the host's pause", () => {
    const { native, onHidden, c } = setup(["Sign"]);
    c.hideScreen();
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenLastCalledWith("manual");
    // Still hidden by hideScreen: neither leaving an excluded screen nor the host's resume records.
    c.setScreen("/Sign");
    c.setScreen("/Home");
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    c.pause();
    c.resume();
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.pause).toHaveBeenCalledTimes(1);
    c.showScreen();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(native.resume).toHaveBeenCalledTimes(1);
    // The host paused: showScreen leaves it paused.
    c.pause();
    c.hideScreen();
    c.showScreen();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(native.resume).toHaveBeenCalledTimes(1);
    c.resume();
    expect(native.resume).toHaveBeenCalledTimes(2);
  });

  it("never starts the native recorder on a hidden screen: it starts once shown, for the current session", () => {
    const native = fakeNative();
    const onHidden = vi.fn();
    const c = createReplayController({ endpoint: ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN, options: { enabled: true }, native, onHidden, logger });
    c.hideScreen();
    expect(onHidden).not.toHaveBeenCalled();
    c.start("sess-1");
    expect(native.start).not.toHaveBeenCalled();
    expect(onHidden).toHaveBeenCalledTimes(1);
    c.sessionDidRotate("sess-2");
    expect(native.start).not.toHaveBeenCalled();
    expect(onHidden).toHaveBeenCalledTimes(2);
    c.showScreen();
    expect(native.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.setSessionId).toHaveBeenCalledWith("sess-2");
    expect(native.pause).not.toHaveBeenCalled();
  });

  it("a session rotated while hidden and active stays paused and is marked", () => {
    const { native, onHidden, c } = setup();
    c.hideScreen();
    c.sessionDidRotate("sess-2");
    expect(native.resume).not.toHaveBeenCalled();
    expect(onHidden).toHaveBeenCalledTimes(2);
    c.stop();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
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

  it("starts the native recorder on the OTLP path: the logs URL, the telemetry resource, the credential and the session id", async () => {
    const rum = initRUM(options({ replay: { enabled: true }, resource: { tenant: "acme" } })) as RUMInternal;
    expect(nativeReplay.setSessionId).toHaveBeenCalledWith(rum.session.id());
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    const [endpoint, started] = nativeReplay.start.mock.calls[0]! as [string, Record<string, unknown> & { otlp: { resource: Record<string, unknown> } }];
    expect(endpoint).toBe(ENDPOINT);
    expect(started).toMatchObject({ sessionId: rum.session.id(), projectId: PROJECT_ID, projectToken: TOKEN, frameInterval: 1, mode: "pixel/frames", cadence: "auto" });
    // Never a prebuilt header value (native builds the Basic credential itself), and no buffer: the whole session is recorded.
    expect(Object.keys(started).sort()).toEqual(["cadence", "debug", "frameInterval", "maskImages", "maskInputs", "maskText", "maskWebViews", "mode", "otlp", "projectId", "projectToken", "sessionId"]);
    expect(started.otlp).toMatchObject({ logsUrl: `${ENDPOINT}/v1/logs`, schemaUrl: "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev", scopeVersion: SDK_VERSION });
    expect(started.otlp).not.toHaveProperty("previousExit");
    // The resource telemetry carries, primitives only.
    expect(started.otlp.resource).toMatchObject({ "service.name": "mobile-store", "service.version": "2.3.0", "deployment.environment.name": "test", "ouo.platform": "mobile", "ouo.sdk.version": SDK_VERSION, tenant: "acme" });
    expect(Object.values(started.otlp.resource).every((v) => ["string", "number", "boolean"].includes(typeof v))).toBe(true);
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

  it("replayEndpoint is gone: it is ignored, and the chunks' URL (the logs URL) is never traced", async () => {
    const rum = initRUM(options({ replay: { enabled: true }, endpoint: "https://otel.example.com/", replayEndpoint: "http://replay.test:9999/" })) as RUMInternal;
    expect(nativeReplay.start.mock.calls[0]![0]).toBe("https://otel.example.com");
    expect((nativeReplay.start.mock.calls[0]![1] as { otlp: { logsUrl: string } }).otlp.logsUrl).toBe("https://otel.example.com/v1/logs");
    await rum.ready;
    expect(rum.getSessionId()).toBeDefined();
  });

  it("tells the native recorder about every session rotation", async () => {
    // The shortest background timeout the SDK accepts is a minute (spec CFG-2): the clock is moved past it.
    const rum = initRUM(options({ replay: { enabled: true }, session: { backgroundTimeoutMs: 60_000 } })) as RUMInternal;
    await rum.ready;
    const first = rum.session.id();
    AppState.__emit("background");
    const backgroundedAt = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => backgroundedAt + 61_000);
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
    await vi.waitFor(() => expect(nativeReplay.resume).toHaveBeenCalledTimes(1), { timeout: SHOW_DELAY_MS + 1000 });
    rum.replay.hideScreen();
    expect(nativeReplay.pause).toHaveBeenCalledTimes(2);
    rum.replay.showScreen();
    await vi.waitFor(() => expect(nativeReplay.resume).toHaveBeenCalledTimes(2), { timeout: SHOW_DELAY_MS + 1000 });
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


describe("replay.mode (ADR-0021 decision 5)", () => {
  const base = { endpoint: ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN };

  it("resolves the option: default, valid, unsupported, invalid, and the old cadence values", () => {
    expect(resolveReplayMode(undefined)).toEqual({ mode: "pixel/frames", cadence: "auto" });
    expect(resolveReplayMode({ mode: "pixel/frames", cadence: "navigation" })).toEqual({ mode: "pixel/frames", cadence: "navigation" });
    // Valid modes this build cannot record: off, one warning.
    const android = new Set<ReplayMode>(["pixel/frames"]);
    for (const [mode, supported] of [["pixel/video", android], ["structure/wireframe", NATIVE_REPLAY_MODES]] as const) {
      const r = resolveReplayMode({ mode }, supported);
      expect(r.mode).toBeUndefined();
      expect(r.warning).toMatch(/not available in this build/);
    }
    // One line makes a mode available: the supported set. The tests run as iOS (the mock's
    // Platform.OS), where pixel/video records.
    expect(resolveReplayMode({ mode: "pixel/video" }, new Set<ReplayMode>(["pixel/frames", "pixel/video"]))).toEqual({ mode: "pixel/video", cadence: "auto" });
    expect(resolveReplayMode({ mode: "pixel/video" })).toEqual({ mode: "pixel/video", cadence: "auto" });
    expect([...NATIVE_REPLAY_MODES]).toEqual(["pixel/frames", "pixel/video"]);
    expect(REPLAY_MODES).toEqual(["pixel/frames", "pixel/video", "structure/wireframe"]);
    // Not modes: shorthand, the web-only mode, junk.
    for (const mode of ["pixel", "structure", "structure/dom", "frames", "", 5, {}, true]) {
      const r = resolveReplayMode({ mode: mode as never });
      expect(r.mode, String(mode)).toBeUndefined();
      expect(r.warning, String(mode)).toMatch(/is not a replay mode/);
    }
    // What replay.mode meant before: read as the cadence, with a deprecation warning, not as invalid.
    for (const cadence of ["auto", "session", "navigation"] as const) {
      const r = resolveReplayMode({ mode: cadence });
      expect(r).toMatchObject({ mode: "pixel/frames", cadence });
      expect(r.warning).toMatch(/deprecated.*replay\.cadence/);
    }
    expect(resolveReplayMode({ mode: "session", cadence: "navigation" })).toMatchObject({ mode: "pixel/frames", cadence: "navigation" });
    expect(resolveReplayMode({ cadence: "junk" as never }).cadence).toBe("auto");
  });

  it("pixel/video is supported on iOS only", async () => {
    // A fresh module graph whose react-native stand-in says Android.
    vi.resetModules();
    try {
      const rn = await import("./mocks/react-native");
      rn.Platform.OS = "android";
      const onAndroid = await import("../src/replay");
      expect([...onAndroid.NATIVE_REPLAY_MODES]).toEqual(["pixel/frames"]);
      expect(onAndroid.resolveReplayMode({ mode: "pixel/video" }).mode).toBeUndefined();
    } finally {
      vi.resetModules();
    }
  });

  it("an unusable mode leaves replay off with one warning and never throws; a deprecated one records", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const mode of ["structure/wireframe", "pixel", "structure/dom", 42]) {
      warn.mockClear();
      const native = fakeNative();
      let c!: ReturnType<typeof createReplayController>;
      expect(() => (c = createReplayController({ ...base, options: { enabled: true, mode: mode as never }, native, logger: createLogger(true) }))).not.toThrow();
      c.start("s");
      c.sessionDidRotate("t");
      c.capture("manual");
      c.mask(5);
      c.screenDidChange();
      c.setAllowed(false);
      c.setAllowed(true);
      c.stop();
      expect(c.active).toBe(false);
      expect(c.mode).toBeUndefined();
      expect(Object.values(native).filter((f) => typeof f === "function" && (f as { mock?: { calls: unknown[] } }).mock?.calls.length).length).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    }
    warn.mockClear();
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true, mode: "navigation" }, native, logger: createLogger(true) });
    c.start("s");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ mode: "pixel/frames", cadence: "navigation" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain("deprecated");
    // Without debug nothing is printed at all.
    warn.mockClear();
    createReplayController({ ...base, options: { enabled: true, mode: "pixel" as never }, native: fakeNative(), logger: createLogger(false) });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("replay over OTLP: the native calls", () => {
  const logger = createLogger(false);
  const base = { endpoint: ENDPOINT, projectId: PROJECT_ID, projectToken: TOKEN, logger };

  it("passes the resource, the scope version and how the previous run ended", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true }, native, resource: { "service.name": "app", n: 1, ok: true }, scopeVersion: "9.9.9", previousExit: "background_kill" });
    c.start("s");
    expect((native.start.mock.calls[0]![1] as { otlp: unknown }).otlp).toEqual({
      logsUrl: `${ENDPOINT}/v1/logs`,
      resource: { "service.name": "app", n: 1, ok: true },
      schemaUrl: "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev",
      scopeVersion: "9.9.9",
      previousExit: "background_kill",
    });
  });

  it("every screen change gives the chunks a fresh 32-hex view id", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true }, native });
    c.screenDidChange();
    expect(native.setViewId).not.toHaveBeenCalled();
    c.start("s");
    c.screenDidChange();
    c.screenDidChange();
    const ids = native.setViewId.mock.calls.map((call) => call[0]);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(newViewId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("mask and unmask take a tag, a ref or an instance, and ignore what is not a mounted view", () => {
    const find = (ref: unknown): number | null => (ref as { __tag?: number }).__tag ?? null;
    expect(nativeTag(12, find)).toBe(12);
    expect(nativeTag({ current: { __tag: 7 } }, find)).toBe(7);
    expect(nativeTag({ __tag: 8 }, find)).toBe(8);
    expect(nativeTag({ current: 9 }, find)).toBe(9);
    for (const junk of [undefined, null, 0, -1, 1.5, NaN, "12", { current: null }, { current: {} }, {}, 2 ** 31]) expect(nativeTag(junk, find), String(junk)).toBeUndefined();
    expect(nativeTag({ current: { __tag: 7 } }, undefined)).toBeUndefined();
    expect(nativeTag({}, () => { throw new Error("x"); })).toBeUndefined();

    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true }, native, findNodeHandle: find });
    // Before the recorder starts too: a mask set at mount must hold for the first frame.
    c.mask({ current: { __tag: 3 } });
    c.unmask(4);
    c.mask("nope");
    c.unmask({ current: null });
    expect(native.mask.mock.calls).toEqual([[3]]);
    expect(native.unmask.mock.calls).toEqual([[4]]);
  });

  it("stop ends the stream with reason stop, end (shutdown) with session_end; an older build without endSession still stops", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true }, native });
    c.start("s");
    c.end();
    expect(native.endSession).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
    expect(c.active).toBe(false);
    c.start("s");
    c.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);
    const { endSession: _gone, ...older } = fakeNative();
    const c2 = createReplayController({ ...base, options: { enabled: true }, native: older });
    c2.start("s");
    c2.end();
    expect(older.stop).toHaveBeenCalledTimes(1);
  });

  it("consent: not started until allowed; withdrawal stops, then deletes what was not sent", async () => {
    const native = fakeNative();
    const order: string[] = [];
    native.stop.mockImplementation(() => void order.push("stop"));
    native.discardPending.mockImplementation(() => {
      order.push("discardPending");
      return Promise.reject(new Error("native failure"));
    });
    const c = createReplayController({ ...base, options: { enabled: true }, native, allowed: false });
    c.start("s");
    expect(native.start).not.toHaveBeenCalled();
    c.setAllowed(true);
    expect(native.start).toHaveBeenCalledTimes(1);
    c.setAllowed(false);
    expect(order).toEqual(["stop", "discardPending"]);
    expect(c.active).toBe(false);
    await Promise.resolve();
    // Withdrawn before anything was recorded: still deletes what an earlier run left.
    const native2 = fakeNative();
    const c2 = createReplayController({ ...base, options: { enabled: true }, native: native2 });
    c2.setAllowed(false);
    expect(native2.stop).not.toHaveBeenCalled();
    expect(native2.discardPending).toHaveBeenCalledTimes(1);
  });
});

describe("initRUM: replay follows the session, errors, consent and shutdown", () => {
  const g = globalThis as { __ouoSessionProcessState?: unknown; ErrorUtils?: { getGlobalHandler: () => (e: unknown, f?: boolean) => void; setGlobalHandler: (h: (e: unknown, f?: boolean) => void) => void }; expo?: unknown };
  let originalFetch: typeof fetch;
  const extra = { capture: vi.fn(), setViewId: vi.fn(), mask: vi.fn(), unmask: vi.fn(), endSession: vi.fn(), discardPending: vi.fn(() => Promise.resolve()), takePendingCrash: vi.fn((): string | null => null), installCrashReporter: vi.fn(() => true) };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    delete g.__ouoSessionProcessState;
    resetNative();
    for (const fn of Object.values(extra)) fn.mockClear();
    extra.takePendingCrash.mockImplementation(() => null);
    g.expo = { modules: { OuoReplay: { ...nativeReplay, ...extra } } };
    let handler = (_e: unknown, _f?: boolean): void => undefined;
    g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h) => (handler = h) };
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.__ouoSessionProcessState;
    delete g.expo;
    delete g.ErrorUtils;
  });

  const options = (replay: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    endpoint: ENDPOINT,
    projectId: PROJECT_ID,
    projectToken: TOKEN,
    service: { name: "mobile-store", version: "2.3.0", environment: "test" },
    storage: new MemoryAsyncStorage(),
    replay: { enabled: true, ...replay },
    ...more,
  });
  const started = (n = 0): Record<string, unknown> & { otlp: Record<string, unknown> } => nativeReplay.start.mock.calls[n]![1] as never;

  it("buffer on error: only a bypass-set record or replay.capture() sends the buffer, once, with its trigger", async () => {
    const rum = initRUM(options({ sampleRate: 0, onErrorSampleRate: 1 })) as RUMInternal;
    await rum.ready;
    expect(started().buffer).toEqual({ seconds: 60 });
    rum.recordException(new Error("handled: not in the bypass set"));
    console.error("a console error: handled too");
    expect(extra.capture).not.toHaveBeenCalled();
    g.ErrorUtils!.getGlobalHandler()(new Error("unhandled"), false);
    expect(extra.capture.mock.calls).toEqual([["error"]]);
    g.ErrorUtils!.getGlobalHandler()(new Error("another"), false);
    rum.replay.capture();
    expect(extra.capture).toHaveBeenCalledTimes(1);

    // The next session has its own buffer: a manual capture, then a fatal error changes nothing.
    rum.restartSession();
    expect(extra.endSession).toHaveBeenCalledTimes(1);
    expect(started(1)).toMatchObject({ sessionId: rum.getSessionId(), buffer: { seconds: 60 } });
    rum.replay.capture();
    expect(extra.capture.mock.calls[1]).toEqual(["manual"]);
    rum.restartSession();
    g.ErrorUtils!.getGlobalHandler()(new Error("fatal"), true);
    expect(extra.capture.mock.calls[2]).toEqual(["crash"]);
  });

  it("previousExit: a native crash report of the previous run is `crash`, a foreground termination `background_kill`", async () => {
    extra.takePendingCrash.mockImplementation(() => JSON.stringify({ mechanism: "signal", timestamp_ms: Date.now() - 1000, session_id: "old", signal: { number: 11, name: "SIGSEGV" }, frames: [], images: [] }));
    const first = initRUM(options({})) as RUMInternal;
    expect(started().otlp["previousExit"]).toBe("crash");
    await first._uninstall();
    delete g.__ouoSessionProcessState;
    resetNative();
    extra.takePendingCrash.mockImplementation(() => JSON.stringify({ mechanism: "termination", timestamp_ms: Date.now() - 1000, session_id: "old", termination: { cause: "memory" }, frames: [], images: [] }));
    const second = initRUM(options({})) as RUMInternal;
    expect(started().otlp["previousExit"]).toBe("background_kill");
    await second.ready;
  });

  it("navigation sets a view id; mask and unmask resolve refs with findNodeHandle", async () => {
    const rum = initRUM(options({})) as RUMInternal;
    await rum.ready;
    rum.trackNavigation("/Home");
    rum.trackNavigation("/Cart");
    expect(extra.setViewId).toHaveBeenCalledTimes(2);
    expect(extra.setViewId.mock.calls[0]![0]).toMatch(/^[0-9a-f]{32}$/);
    rum.replay.mask({ current: { __tag: 21 } });
    rum.replay.unmask(22);
    rum.replay.mask({ current: null });
    expect(extra.mask.mock.calls).toEqual([[21]]);
    expect(extra.unmask.mock.calls).toEqual([[22]]);
  });

  it("an unsampled session and a session without replay consent record nothing; withdrawal stops and discards", async () => {
    const unsampled = initRUM(options({}, { session: { sampleRate: 0 } })) as RUMInternal;
    await unsampled.ready;
    expect(nativeReplay.start).not.toHaveBeenCalled();
    await unsampled._uninstall();
    delete g.__ouoSessionProcessState;

    const rum = initRUM(options({}, { consent: { required: true } })) as RUMInternal;
    await rum.ready;
    rum.setConsent({ telemetry: true });
    expect(nativeReplay.start).not.toHaveBeenCalled();
    rum.setConsent({ replay: true });
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    rum.setConsent({ replay: false });
    expect(nativeReplay.stop).toHaveBeenCalledTimes(1);
    expect(extra.discardPending).toHaveBeenCalledTimes(1);
  });

  it("shutdown ends the stream with the session, then flushes; self-disable stops it", async () => {
    const order: string[] = [];
    extra.endSession.mockImplementation(() => void order.push("endSession"));
    nativeReplay.flush.mockImplementation(() => {
      order.push("flush");
      return Promise.resolve();
    });
    const rum = initRUM(options({})) as RUMInternal;
    await rum.ready;
    order.length = 0;
    await rum.shutdown();
    expect(order).toEqual(["endSession", "flush"]);
    expect(nativeReplay.stop).not.toHaveBeenCalled();

    delete g.__ouoSessionProcessState;
    resetNative();
    const second = initRUM(options({}, { diagnostics: { selfDisableThreshold: 1 } })) as RUMInternal;
    await second.ready;
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("injected");
    });
    second.recordEvent("fails");
    vi.restoreAllMocks();
    expect(guard.disabled).toBe(true);
    expect(nativeReplay.stop).toHaveBeenCalledTimes(1);
  });
});
