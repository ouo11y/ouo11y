import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({}) as Record<string, (m: unknown) => void>);
const inpOpts = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("web-vitals", () => ({
  onCLS: (cb: (m: unknown) => void) => (handlers["CLS"] = cb),
  onFCP: (cb: (m: unknown) => void) => (handlers["FCP"] = cb),
  onINP: (cb: (m: unknown) => void, opts: unknown) => ((handlers["INP"] = cb), (inpOpts.value = opts)),
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

  it("INP follows every change and is emitted once per value when the page is hidden", () => {
    const emit = vi.fn();
    const uninstall = installWebVitals({ emit } as never);
    expect(inpOpts.value).toEqual({ reportAllChanges: true });
    const hide = (state: DocumentVisibilityState) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const inp = (value: number) => handlers["INP"]!({ name: "INP", value, rating: "good", id: "inp-1", delta: value, navigationType: "navigate" });
    hide("hidden");
    expect(emit).not.toHaveBeenCalled();
    inp(48);
    inp(120);
    expect(emit).not.toHaveBeenCalled();
    hide("hidden");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.name": "INP", "ouo.web_vital.value": 120, "ouo.web_vital.delta": 120 }));
    hide("visible");
    hide("hidden");
    expect(emit).toHaveBeenCalledTimes(1);
    inp(200);
    hide("hidden");
    expect(emit).toHaveBeenLastCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.value": 200, "ouo.web_vital.delta": 80 }));
    // Safari closes a tab with pagehide only.
    inp(260);
    window.dispatchEvent(new Event("pagehide"));
    expect(emit).toHaveBeenLastCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.value": 260 }));
    expect(emit).toHaveBeenCalledTimes(3);
    uninstall();
  });
});
