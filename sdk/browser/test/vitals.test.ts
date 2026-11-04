import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({}) as Record<string, (m: unknown) => void>);
const inpOpts = vi.hoisted(() => ({ value: undefined as undefined | { reportAllChanges?: boolean; generateTarget?: (n: Node | null) => string | undefined } }));
vi.mock("web-vitals/attribution", () => ({
  onCLS: (cb: (m: unknown) => void) => (handlers["CLS"] = cb),
  onFCP: (cb: (m: unknown) => void) => (handlers["FCP"] = cb),
  onINP: (cb: (m: unknown) => void, opts: never) => ((handlers["INP"] = cb), (inpOpts.value = opts)),
  onLCP: (cb: (m: unknown) => void) => (handlers["LCP"] = cb),
  onTTFB: (cb: (m: unknown) => void) => (handlers["TTFB"] = cb),
}));

import { installWebVitals } from "../src/vitals";
import { inpAttributes, webVitalAttributes } from "../src/vitals/attribution";

/** The vitals chunk is imported lazily: wait until web-vitals is subscribed. */
const loaded = () => vi.waitFor(() => expect(handlers["INP"]).toBeTypeOf("function"));

const script = {
  entry: { invoker: "BUTTON#save.onclick", invokerType: "event-listener", sourceURL: "https://shop.example/app.js", sourceFunctionName: "save", sourceCharPosition: 812, duration: 180 },
  subpart: "processing-duration",
  intersectingDuration: 172.46,
} as const;

describe("web_vital event mapping", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
  });

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

  it("maps INP attribution: target, type, phases and the longest LoAF script", () => {
    const attrs = inpAttributes(
      {
        interactionTarget: "button#save",
        interactionType: "pointer",
        inputDelay: 12.04,
        processingDuration: 180.26,
        presentationDelay: 31.5,
        loadState: "complete",
        longestScript: script as never,
      },
      (t) => t === "button#save",
    );
    expect(attrs).toEqual({
      "ouo.web_vital.inp.target": "button#save",
      "ouo.web_vital.inp.interaction_type": "pointer",
      "ouo.web_vital.inp.input_delay_ms": 12,
      "ouo.web_vital.inp.processing_duration_ms": 180.3,
      "ouo.web_vital.inp.presentation_delay_ms": 31.5,
      "ouo.web_vital.inp.load_state": "complete",
      "ouo.web_vital.inp.script.duration_ms": 172.5,
      "ouo.web_vital.inp.script.subpart": "processing-duration",
      "ouo.web_vital.inp.script.invoker": "BUTTON#save.onclick",
      "ouo.web_vital.inp.script.invoker_type": "event-listener",
      "code.file.path": "https://shop.example/app.js",
      "code.function.name": "save",
      "ouo.web_vital.inp.script.char_position": 812,
    });
  });

  it("leaves out a target the SDK did not generate (the browser's own targetSelector)", () => {
    const attrs = inpAttributes({ interactionTarget: "div.patient-row > span", inputDelay: 1 }, () => false);
    expect(attrs["ouo.web_vital.inp.target"]).toBeUndefined();
    expect(attrs["ouo.web_vital.inp.input_delay_ms"]).toBe(1);
  });

  it("subscribes to CLS, FCP, INP, LCP and TTFB from the lazy chunk and emits web_vital events", async () => {
    const emit = vi.fn();
    const uninstall = installWebVitals({ emit } as never);
    await loaded();
    expect(Object.keys(handlers).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
    handlers["CLS"]!({ name: "CLS", value: 0.01, rating: "good", id: "x", delta: 0.01, navigationType: "navigate" });
    expect(emit).toHaveBeenCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.name": "CLS", "ouo.web_vital.value": 0.01, "url.path": location.pathname }));
    uninstall();
    handlers["CLS"]!({ name: "CLS", value: 0.02, rating: "good", id: "x", delta: 0.01, navigationType: "navigate" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("INP keeps the route of the interaction, not the route at page hide", async () => {
    const emit = vi.fn();
    const route = { name: "/patients/:id" as string | undefined };
    const uninstall = installWebVitals({ emit } as never, route);
    await loaded();
    handlers["INP"]!({ name: "INP", value: 320, rating: "needs-improvement", id: "inp-r", delta: 320, navigationType: "navigate", attribution: {} });
    route.name = "/logout";
    window.dispatchEvent(new Event("pagehide"));
    expect(emit).toHaveBeenLastCalledWith("web_vital", expect.objectContaining({ "ouo.web_vital.value": 320, "app.screen.name": "/patients/:id" }));
    uninstall();
  });

  it("the INP target is the clicked element's app.widget.id, without text", async () => {
    const uninstall = installWebVitals({ emit: vi.fn() } as never);
    await loaded();
    document.body.innerHTML = `<main><button id="save" class="btn primary" aria-label="Save Jane Doe's record"><span>Jane Doe</span></button><div><p>free text</p></div></main>`;
    const generate = inpOpts.value!.generateTarget!;
    expect(generate(document.querySelector("span"))).toBe("button#save.btn.primary");
    expect(generate(document.querySelector("p"))).toBe("p");
    expect(generate(document.createTextNode("x"))).toBe("");
    uninstall();
  });

  it("INP follows every change and is emitted once per value when the page is hidden", async () => {
    const emit = vi.fn();
    const uninstall = installWebVitals({ emit } as never);
    await loaded();
    expect(inpOpts.value).toEqual(expect.objectContaining({ reportAllChanges: true }));
    const hide = (state: DocumentVisibilityState) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    };
    document.body.innerHTML = `<button id="save">Save</button>`;
    const target = inpOpts.value!.generateTarget!(document.querySelector("button"))!;
    const inp = (value: number) =>
      handlers["INP"]!({
        name: "INP",
        value,
        rating: "good",
        id: "inp-1",
        delta: value,
        navigationType: "navigate",
        attribution: { interactionTarget: target, interactionType: "pointer", inputDelay: 2, processingDuration: value - 10, presentationDelay: 8, loadState: "complete", longestScript: script },
      });
    hide("hidden");
    expect(emit).not.toHaveBeenCalled();
    inp(48);
    inp(120);
    expect(emit).not.toHaveBeenCalled();
    hide("hidden");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(
      "web_vital",
      expect.objectContaining({
        "ouo.web_vital.name": "INP",
        "ouo.web_vital.value": 120,
        "ouo.web_vital.delta": 120,
        "ouo.web_vital.inp.target": "button#save",
        "ouo.web_vital.inp.processing_duration_ms": 110,
        "code.function.name": "save",
      }),
    );
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
