import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({}) as Record<string, (m: unknown) => void>);
vi.mock("web-vitals", () => ({
  onCLS: (cb: (m: unknown) => void) => (handlers["CLS"] = cb),
  onFCP: (cb: (m: unknown) => void) => (handlers["FCP"] = cb),
  onINP: (cb: (m: unknown) => void) => (handlers["INP"] = cb),
  onLCP: (cb: (m: unknown) => void) => (handlers["LCP"] = cb),
  onTTFB: (cb: (m: unknown) => void) => (handlers["TTFB"] = cb),
}));

import { installWebVitals, webVitalAttributes } from "../src/vitals";

describe("web_vital event mapping", () => {
  it("maps a web-vitals metric to ouo.web_vital.* attributes", () => {
    const attrs = webVitalAttributes(
      { name: "LCP", value: 1234.5, rating: "needs-improvement", id: "v6-1", delta: 1234.5, navigationType: "navigate" },
      "/cart",
    );
    expect(attrs).toEqual({
      "ouo.web_vital.name": "LCP",
      "ouo.web_vital.value": 1234.5,
      "ouo.web_vital.rating": "needs-improvement",
      "ouo.web_vital.id": "v6-1",
      "ouo.web_vital.delta": 1234.5,
      "ouo.web_vital.navigation_type": "navigate",
      "url.path": "/cart",
    });
  });

  it("subscribes to CLS, FCP, INP, LCP and TTFB and emits web_vital events", () => {
    const emit = vi.fn();
    installWebVitals({ emit } as never);
    expect(Object.keys(handlers).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
    handlers["CLS"]!({ name: "CLS", value: 0.01, rating: "good", id: "x", delta: 0.01, navigationType: "navigate" });
    expect(emit).toHaveBeenCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.name": "CLS", "ouo.web_vital.value": 0.01, "url.path": location.pathname }));
  });
});
