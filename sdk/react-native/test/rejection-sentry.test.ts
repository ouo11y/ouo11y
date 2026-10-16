import { afterEach, describe, expect, it, vi } from "vitest";
import { installErrorCapture } from "../src/errors/install";
import { sentryClientPresent } from "../src/errors/sentry";
import type { EventEmitter } from "../src/telemetry/events";

type Tracker = { onUnhandled: (id: number, error: unknown) => void };

/** Hermes: one tracker, every enablePromiseRejectionTracker call replaces it; HermesInternal is frozen. */
function fakeHermes() {
  const state: { tracker?: Tracker } = {};
  const host = Object.freeze({
    hasPromise: () => true,
    enablePromiseRejectionTracker(options: Tracker) {
      state.tracker = options;
    },
  });
  return { host, reject: (error: unknown) => state.tracker?.onUnhandled(1, error) };
}

const g = globalThis as { HermesInternal?: unknown; __SENTRY__?: unknown };
const sentryCarrier = (client: unknown) => ({ version: "10.26.0", "10.26.0": { defaultCurrentScope: { getClient: () => client } } });

afterEach(() => {
  delete g.HermesInternal;
  delete g.__SENTRY__;
});

function capture(opts: { onUnhandledRejection?: (e: unknown) => void } = {}) {
  const warn = vi.fn();
  const emitted: Array<Record<string, unknown>> = [];
  const events = { emit: (_name: string, attrs: Record<string, unknown>) => emitted.push(attrs) } as unknown as EventEmitter;
  const uninstall = installErrorCapture({ events, logger: { enabled: true, log: () => {}, warn }, onFatal: async () => {}, consoleErrors: false, ...opts });
  return { warn, emitted, uninstall };
}

describe("next to Sentry: one Hermes rejection tracker", () => {
  it("the last registration wins: ouo initialised after Sentry owns the tracker", () => {
    const { host, reject } = fakeHermes();
    g.HermesInternal = host;
    const sentry = vi.fn();
    host.enablePromiseRejectionTracker({ onUnhandled: sentry }); // Sentry.init
    const { emitted, uninstall } = capture();
    reject(new Error("x"));
    expect(emitted).toHaveLength(1);
    expect(sentry).not.toHaveBeenCalled();
    uninstall();
  });

  it("errors.onUnhandledRejection hands every rejection on (to Sentry.captureException)", () => {
    const { host, reject } = fakeHermes();
    g.HermesInternal = host;
    const forward = vi.fn();
    const { emitted, warn, uninstall } = capture({ onUnhandledRejection: forward });
    const err = new Error("rejected");
    reject(err);
    expect(emitted[0]).toMatchObject({ "ouo.exception.kind": "unhandledrejection", "exception.message": "rejected" });
    expect(forward).toHaveBeenCalledWith(err);
    expect(warn.mock.calls.some(([m]) => /Sentry/.test(String(m)))).toBe(false);
    uninstall();
  });

  it("a throwing forwarder does not lose ouo's record", () => {
    const { host, reject } = fakeHermes();
    g.HermesInternal = host;
    const { emitted, uninstall } = capture({
      onUnhandledRejection: () => {
        throw new Error("forwarder bug");
      },
    });
    expect(() => reject(new Error("x"))).not.toThrow();
    expect(emitted).toHaveLength(1);
    uninstall();
  });

  it("warns when a Sentry client exists and nothing forwards rejections to it", () => {
    g.HermesInternal = fakeHermes().host;
    g.__SENTRY__ = sentryCarrier({});
    const { warn, uninstall } = capture();
    expect(warn.mock.calls.some(([m]) => /Sentry no longer gets unhandled rejections/.test(String(m)))).toBe(true);
    uninstall();
  });

  it("detects a Sentry client in the __SENTRY__ carrier, not a merely imported SDK", () => {
    expect(sentryClientPresent()).toBe(false);
    g.__SENTRY__ = sentryCarrier(undefined);
    expect(sentryClientPresent()).toBe(false);
    g.__SENTRY__ = sentryCarrier({ name: "client" });
    expect(sentryClientPresent()).toBe(true);
  });
});
