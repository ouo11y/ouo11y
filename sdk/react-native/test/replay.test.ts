import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger";
import { _setExpoModulesCore, createReplayController, defaultReplayEndpoint, loadNativeReplayModule, type NativeReplayModule } from "../src/replay";
import { MemoryAsyncStorage } from "../src/session/storage";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { AppState } from "./mocks/react-native";
import * as expoModulesCoreMock from "./mocks/expo-modules-core";

const { nativeReplay, resetNative, setNativeAvailable } = expoModulesCoreMock;
// The SDK reaches expo-modules-core through a bare require (Metro resolves it); point it at the mock here.
_setExpoModulesCore(() => expoModulesCoreMock);

const ENDPOINT = "http://collector.test:4318";

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
    stop: vi.fn(),
  } satisfies NativeReplayModule & { recording: boolean };
  return n;
}

describe("defaultReplayEndpoint", () => {
  it("keeps scheme and host, uses port 8080", () => {
    expect(defaultReplayEndpoint("http://localhost:4328")).toBe("http://localhost:8080");
    expect(defaultReplayEndpoint("https://otel.example.com/")).toBe("https://otel.example.com:8080");
    expect(defaultReplayEndpoint("http://192.168.1.20:4318/v1")).toBe("http://192.168.1.20:8080");
    expect(defaultReplayEndpoint("not a url")).toBeUndefined();
  });
});

describe("replay controller", () => {
  const logger = createLogger(false);

  it("starts the native recorder with the endpoint, session id and option defaults", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native, logger });
    expect(c.active).toBe(false);
    c.start("sess-1");
    expect(native.setSessionId).toHaveBeenCalledWith("sess-1");
    expect(native.start).toHaveBeenCalledWith("http://localhost:8080", {
      sessionId: "sess-1",
      frameInterval: 1,
      maskText: true,
      maskImages: true,
      maskWebViews: true,
      debug: false,
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
      options: { enabled: true, frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false },
      native,
      logger: createLogger(true),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    c.start("s");
    expect(native.start.mock.calls[0]![1]).toMatchObject({ frameInterval: 0.5, maskText: false, maskImages: false, maskWebViews: false, debug: true });
  });

  it("pause / resume / isRecording delegate to the native module", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native, logger });
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
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native, logger });
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
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native, logger });
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
    const c = createReplayController({ endpoint: "http://localhost:8080", options: undefined, native, logger });
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
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native: null, logger: createLogger(true) });
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
    const c = createReplayController({ endpoint: "http://localhost:8080", options: { enabled: true }, native, logger });
    expect(() => c.start("s")).not.toThrow();
    expect(c.active).toBe(false);
  });

  it("does not start without an endpoint", () => {
    const native = fakeNative();
    const c = createReplayController({ endpoint: undefined, options: { enabled: true }, native, logger });
    c.start("s");
    expect(native.start).not.toHaveBeenCalled();
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
    service: { name: "mobile-store", version: "2.3.0", environment: "test" },
    storage: new MemoryAsyncStorage(),
    ...extra,
  });

  it("starts the native recorder with the default replay endpoint and the session id", async () => {
    const rum = initRUM(options({ replay: { enabled: true } })) as RUMInternal;
    expect(nativeReplay.setSessionId).toHaveBeenCalledWith(rum.session.id());
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    expect(nativeReplay.start).toHaveBeenCalledWith("http://collector.test:8080", expect.objectContaining({ sessionId: rum.session.id(), frameInterval: 1 }));
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

  it("uses replayEndpoint when given", () => {
    initRUM(options({ replay: { enabled: true }, replayEndpoint: "http://rum.test:9999/" }));
    expect(nativeReplay.start.mock.calls[0]![0]).toBe("http://rum.test:9999");
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
