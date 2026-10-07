import { afterEach, describe, expect, it, vi } from "vitest";
import { exceptionAttributes, serializeConsoleArgs, serializeError } from "../src/errors/classify";
import { installErrorCapture, type GlobalErrorHandler } from "../src/errors/install";
import type { EventEmitter } from "../src/telemetry/events";
import { createLogger } from "../src/logger";

interface Emitted {
  name: string;
  attrs: Record<string, unknown>;
  severity: string | undefined;
}

function fakeEvents(): { events: EventEmitter; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const events = {
    emit: (name: string, attrs: Record<string, unknown> = {}, severity?: string) => {
      emitted.push({ name, attrs, severity });
    },
  } as unknown as EventEmitter;
  return { events, emitted };
}

/** React Native style ErrorUtils stub. */
function fakeErrorUtils() {
  let handler: GlobalErrorHandler = () => {};
  const calls: Array<[unknown, boolean | undefined]> = [];
  const defaultHandler: GlobalErrorHandler = (e, f) => {
    calls.push([e, f]);
  };
  handler = defaultHandler;
  return {
    utils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        handler = h;
      },
    },
    current: () => handler,
    defaultCalls: calls,
  };
}

const g = globalThis as { ErrorUtils?: unknown; HermesInternal?: unknown };
// jsdom window pieces without the DOM lib in tsconfig (the SDK itself is DOM-free).
const win = globalThis as unknown as EventTarget;
type ErrorEventCtor = new (type: string, init: { error?: unknown; message?: string }) => Event;
const ErrorEventC = (globalThis as unknown as { ErrorEvent: ErrorEventCtor }).ErrorEvent;

afterEach(() => {
  delete g.ErrorUtils;
  delete g.HermesInternal;
});

describe("exception classification (ADR-0004, mobile)", () => {
  it("serialises errors, objects and primitives", () => {
    const err = new TypeError("bad");
    expect(serializeError(err)).toMatchObject({ type: "TypeError", message: "bad" });
    expect(serializeError(err).stacktrace).toContain("bad");
    expect(serializeError({ name: "Custom", message: "m" })).toEqual({ type: "Custom", message: "m", stacktrace: "" });
    expect(serializeError("plain")).toEqual({ type: "Error", message: "plain", stacktrace: "" });
    expect(serializeError(42)).toEqual({ type: "Number", message: "42", stacktrace: "" });
  });

  it("only the global handler's isFatal flag makes an exception fatal", () => {
    expect(exceptionAttributes(new Error("x"), "uncaught", true)).toMatchObject({ "ouo.exception.fatal": true, "ouo.exception.handled": false });
    expect(exceptionAttributes(new Error("x"), "uncaught", false)).toMatchObject({ "ouo.exception.fatal": false, "ouo.exception.handled": false });
    expect(exceptionAttributes(new Error("x"), "unhandledrejection", false)).toMatchObject({ "ouo.exception.fatal": false, "ouo.exception.handled": false });
    expect(exceptionAttributes(new Error("x"), "captured", false, { "cart.id": "c1" })).toMatchObject({
      "ouo.exception.fatal": false,
      "ouo.exception.handled": true,
      "cart.id": "c1",
    });
    expect(exceptionAttributes(new Error("x"), "console", false)).toMatchObject({ "ouo.exception.fatal": false, "ouo.exception.handled": true });
  });

  it("joins console.error arguments and keeps the first Error's stack", () => {
    const err = new RangeError("r");
    const { error, message } = serializeConsoleArgs(["failed:", err, { a: 1 }]);
    expect(message).toBe("failed: RangeError: r {\"a\":1}");
    expect((error as Error).name).toBe("RangeError");
    expect((error as Error).stack).toBe(err.stack);
  });
});

describe("installErrorCapture", () => {
  it("fatal error: emits exception(fatal=true), runs onFatal, then the previous handler", async () => {
    const eu = fakeErrorUtils();
    g.ErrorUtils = eu.utils;
    const { events, emitted } = fakeEvents();
    const order: string[] = [];
    const onFatal = vi.fn(async () => {
      order.push("onFatal");
      await new Promise((r) => setTimeout(r, 5));
    });
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal, consoleErrors: false });
    const boom = new Error("fatal boom");
    eu.current()(boom, true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ name: "exception", severity: "error" });
    expect(emitted[0]!.attrs).toMatchObject({
      "exception.type": "Error",
      "exception.message": "fatal boom",
      "ouo.exception.fatal": true,
      "ouo.exception.handled": false,
      "ouo.exception.kind": "uncaught",
    });
    expect(onFatal).toHaveBeenCalledWith(boom);
    // The previous handler (red box / native crash) runs only after onFatal settled.
    expect(eu.defaultCalls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(eu.defaultCalls).toEqual([[boom, true]]);
    uninstall();
    expect(eu.current()).not.toBe(undefined);
    eu.current()(new Error("after uninstall"), true);
    expect(emitted).toHaveLength(1);
  });

  it("non-fatal error: emits exception(fatal=false, handled=false) and calls the previous handler synchronously", () => {
    const eu = fakeErrorUtils();
    g.ErrorUtils = eu.utils;
    const { events, emitted } = fakeEvents();
    const onFatal = vi.fn(async () => {});
    installErrorCapture({ events, logger: createLogger(false), onFatal, consoleErrors: false })();
    const eu2 = fakeErrorUtils();
    g.ErrorUtils = eu2.utils;
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal, consoleErrors: false });
    eu2.current()(new Error("soft"), false);
    expect(emitted.at(-1)!.attrs).toMatchObject({ "ouo.exception.fatal": false, "ouo.exception.handled": false });
    expect(onFatal).not.toHaveBeenCalled();
    expect(eu2.defaultCalls).toHaveLength(1);
    uninstall();
  });

  it("unhandled promise rejections via HermesInternal are non-fatal, unhandled exceptions", () => {
    let tracker: { onUnhandled: (id: number, e: unknown) => void } | undefined;
    g.HermesInternal = {
      hasPromise: () => true,
      enablePromiseRejectionTracker: (o: { onUnhandled: (id: number, e: unknown) => void }) => {
        tracker = o;
      },
    };
    const { events, emitted } = fakeEvents();
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal: async () => {}, consoleErrors: false });
    expect(tracker).toBeDefined();
    tracker!.onUnhandled(1, new Error("rejected"));
    expect(emitted[0]!.attrs).toMatchObject({
      "exception.message": "rejected",
      "ouo.exception.fatal": false,
      "ouo.exception.handled": false,
      "ouo.exception.kind": "unhandledrejection",
    });
    uninstall();
  });

  it("console.error is reported as a handled, non-fatal exception and still prints", () => {
    const { events, emitted } = fakeEvents();
    const original = console.error;
    const printed = vi.fn();
    console.error = printed;
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal: async () => {} });
    console.error("something", new Error("inner"));
    expect(printed).toHaveBeenCalledTimes(1);
    expect(emitted[0]!.attrs).toMatchObject({
      "exception.type": "Error",
      "exception.message": "something Error: inner",
      "ouo.exception.fatal": false,
      "ouo.exception.handled": true,
      "ouo.exception.kind": "console",
    });
    uninstall();
    expect(console.error).toBe(printed);
    console.error = original;
  });

  it("with ErrorUtils AND a window (Expo web) the window error path still captures a fatal, once per error object", async () => {
    const eu = fakeErrorUtils();
    g.ErrorUtils = eu.utils;
    delete g.HermesInternal;
    const { events, emitted } = fakeEvents();
    const onFatal = vi.fn(async () => {});
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal, consoleErrors: false });
    const boom = new Error("timer boom");
    // Browser timers bypass ErrorUtils: only the window event fires.
    win.dispatchEvent(new ErrorEventC("error", { error: boom, message: "timer boom" }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.attrs).toMatchObject({ "exception.message": "timer boom", "ouo.exception.fatal": true });
    expect(onFatal).toHaveBeenCalledTimes(1);
    // The same error object reaching ErrorUtils afterwards is not reported twice, but the previous handler still runs.
    eu.current()(boom, true);
    expect(emitted).toHaveLength(1);
    expect(eu.defaultCalls).toEqual([[boom, true]]);
    // Unhandled rejections use the window event when ErrorUtils is present but Hermes is not.
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("web rejected");
    win.dispatchEvent(rejection);
    expect(emitted[1]!.attrs).toMatchObject({ "exception.message": "web rejected", "ouo.exception.fatal": false, "ouo.exception.kind": "unhandledrejection" });
    uninstall();
  });

  it("without ErrorUtils (react-native-web) an uncaught window error is fatal and an unhandledrejection is not", async () => {
    delete g.ErrorUtils;
    delete g.HermesInternal;
    const { events, emitted } = fakeEvents();
    const onFatal = vi.fn(async () => {});
    const uninstall = installErrorCapture({ events, logger: createLogger(false), onFatal, consoleErrors: false });
    win.dispatchEvent(new ErrorEventC("error", { error: new Error("web boom"), message: "web boom" }));
    expect(emitted[0]!.attrs).toMatchObject({ "exception.message": "web boom", "ouo.exception.fatal": true, "ouo.exception.handled": false });
    expect(onFatal).toHaveBeenCalledTimes(1);
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("web rejected");
    win.dispatchEvent(rejection);
    expect(emitted[1]!.attrs).toMatchObject({ "exception.message": "web rejected", "ouo.exception.fatal": false, "ouo.exception.kind": "unhandledrejection" });
    uninstall();
    // vitest reports a window "error" event as an uncaught exception once no user listener is
    // registered; keep a no-op listener around for the post-uninstall dispatch.
    const swallow = (): void => {};
    win.addEventListener("error", swallow);
    win.dispatchEvent(new ErrorEventC("error", { error: new Error("after"), message: "after" }));
    win.removeEventListener("error", swallow);
    expect(emitted).toHaveLength(2);
  });
});
