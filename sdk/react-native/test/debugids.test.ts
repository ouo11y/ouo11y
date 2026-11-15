import { afterEach, describe, expect, it } from "vitest";
import { exceptionAttributes } from "../src/errors/classify";
import { debugIdAttribute } from "../src/errors/debugids";

type G = { __ouoDebugIds?: Record<string, unknown>; _sentryDebugIds?: Record<string, unknown> };
const g = globalThis as G;
const OTA = "0193a5c2-7d1e-4f00-8a3b-5c6d7e8f9a0b";
const EMBEDDED = "a85fbba4-b2c5-43ea-8375-32618ac67e06";

afterEach(() => {
  delete g.__ouoDebugIds;
  delete g._sentryDebugIds;
});

function hermesError(file: string): Error {
  const err = new Error("card declined: 120");
  err.stack = `Error: card declined: 120\n    at chargeCard (address at ${file}:1:11313)\n    at checkout (address at ${file}:1:11309)\n    at anonymous (native)`;
  return err;
}

describe("ouo.exception.debug_ids (ADR-0011 section 6)", () => {
  it("names the running OTA bundle under the location the normalised stack uses", () => {
    // hot-updater loads the OTA bundle from the app's files; the snippet registered that path.
    const file = "/data/user/0/com.example.app/files/bundle-store/0193a5c2/index.android.bundle";
    g.__ouoDebugIds = { [file]: OTA.toUpperCase() };
    const attrs = exceptionAttributes(hermesError(file), "uncaught", true);
    expect(attrs["exception.stacktrace"]).toContain("at chargeCard (app:///index.android.bundle:1:11313) [in app]");
    expect(JSON.parse(attrs["ouo.exception.debug_ids"] as string)).toEqual({ "app:///index.android.bundle": OTA });
  });

  it("covers the embedded iOS bundle and every exception kind", () => {
    const file = "/private/var/containers/Bundle/Application/8F6B2A1C-0D4E-4C1B-9A55-2B7C3D4E5F60/Example.app/main.jsbundle";
    g.__ouoDebugIds = { [file]: EMBEDDED };
    for (const kind of ["uncaught", "unhandledrejection", "console", "captured", "sentry"] as const) {
      expect(exceptionAttributes(hermesError(file), kind, false)["ouo.exception.debug_ids"]).toBe(`{"app:///main.jsbundle":"${EMBEDDED}"}`);
    }
  });

  it("is absent when no bundle registered an id or the stack names another file", () => {
    expect(debugIdAttribute("Error: x\n  at f (app:///index.android.bundle:1:2)")).toEqual({});
    g.__ouoDebugIds = { "index.android.bundle": OTA };
    expect(debugIdAttribute("Error: x\n  at f (app:///main.jsbundle:1:2)")).toEqual({});
    expect(debugIdAttribute("")).toEqual({});
    g.__ouoDebugIds = { "index.android.bundle": "not-a-uuid" };
    expect(debugIdAttribute("Error: x\n  at f (app:///index.android.bundle:1:2)")).toEqual({});
  });

  it("falls back to Sentry's registry (keyed by a stack), for apps still built with Sentry's Metro plugin", () => {
    g._sentryDebugIds = { "Error\n    at anonymous (address at index.android.bundle:1:120)\n    at global (address at index.android.bundle:1:9)": EMBEDDED };
    expect(debugIdAttribute("Error: x\n  at f (app:///index.android.bundle:1:2) [in app]")).toEqual({ "ouo.exception.debug_ids": `{"app:///index.android.bundle":"${EMBEDDED}"}` });
    // ouo's own registration wins.
    g.__ouoDebugIds = { "index.android.bundle": OTA };
    expect(debugIdAttribute("Error: x\n  at f (app:///index.android.bundle:1:2)")).toEqual({ "ouo.exception.debug_ids": `{"app:///index.android.bundle":"${OTA}"}` });
  });

  it("never throws on a broken registry", () => {
    Object.defineProperty(g, "__ouoDebugIds", { configurable: true, get: () => { throw new Error("nope"); } });
    expect(debugIdAttribute("Error: x\n  at f (app:///index.android.bundle:1:2)")).toEqual({});
  });
});
