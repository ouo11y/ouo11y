import { afterEach, describe, expect, it } from "vitest";
import { debugIdAttribute, exceptionAttributes } from "../src/errors/classify";

const g = globalThis as { __ouoDebugIds?: Record<string, string> };

const chromeStack = (url: string) => `Error\n    at ${url}:1:20\n    at ${url}:1:40`;
const firefoxStack = (url: string) => `@${url}:1:20\n`;

describe("debug ids on exceptions (ADR-0011)", () => {
  afterEach(() => {
    delete g.__ouoDebugIds;
  });

  it("sends nothing when no bundle registered a debug id", () => {
    const a = exceptionAttributes(new Error("boom"), "uncaught");
    expect(a["ouo.exception.debug_ids"]).toBeUndefined();
  });

  it("maps the scripts the stack names to their debug ids", () => {
    g.__ouoDebugIds = {
      [chromeStack("https://shop.example/assets/index-B3x9.js")]: "c0ffee00-0000-4000-8000-000000000001",
      [firefoxStack("https://shop.example/assets/vendor-77.js")]: "c0ffee00-0000-4000-8000-000000000002",
      [chromeStack("https://shop.example/assets/unused.js")]: "c0ffee00-0000-4000-8000-000000000003",
    };
    const stack = [
      "TypeError: x is undefined",
      "    at o (https://shop.example/assets/index-B3x9.js:1:18734)",
      "    at https://shop.example/assets/vendor-77.js:2:99",
      "    at o (https://shop.example/assets/index-B3x9.js:1:200)",
      "    at native (https://other.example/lib.js:1:1)",
    ].join("\n");
    const attr = debugIdAttribute(stack)["ouo.exception.debug_ids"];
    expect(JSON.parse(String(attr))).toEqual({
      "https://shop.example/assets/index-B3x9.js": "c0ffee00-0000-4000-8000-000000000001",
      "https://shop.example/assets/vendor-77.js": "c0ffee00-0000-4000-8000-000000000002",
    });
  });

  it("reads Firefox / Safari frames and URLs with a port", () => {
    g.__ouoDebugIds = { [firefoxStack("http://localhost:4173/assets/index.js")]: "id-1" };
    const attr = debugIdAttribute("RenderBomb@http://localhost:4173/assets/index.js:40:1234\n")["ouo.exception.debug_ids"];
    expect(JSON.parse(String(attr))).toEqual({ "http://localhost:4173/assets/index.js": "id-1" });
  });

  it("picks up bundles registered after the first exception", () => {
    g.__ouoDebugIds = { [chromeStack("https://a.example/a.js")]: "id-a" };
    expect(debugIdAttribute("at https://b.example/b.js:1:1")).toEqual({});
    g.__ouoDebugIds[chromeStack("https://b.example/b.js")] = "id-b";
    expect(JSON.parse(String(debugIdAttribute("at https://b.example/b.js:1:1")["ouo.exception.debug_ids"]))).toEqual({
      "https://b.example/b.js": "id-b",
    });
  });

  it("never throws on a hostile registry", () => {
    g.__ouoDebugIds = new Proxy({}, { ownKeys: () => { throw new Error("nope"); } }) as Record<string, string>;
    expect(debugIdAttribute("at https://a.example/a.js:1:1")).toEqual({});
  });
});
