import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ouo from "../src/index";
import { OuoErrorBoundary, routeTemplate, useOuoRoute } from "../src/react/index";
import { FakeCollector } from "./helpers/collector";

const BASE = "http://collector.test:4318";
const collector = new FakeCollector(BASE);

beforeEach(() => {
  localStorage.clear();
  collector.reset();
  collector.install();
  document.body.innerHTML = `<div id="root"></div>`;
  history.replaceState(null, "", "/");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await ouo.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Bomb(): never {
  throw new Error("render failed");
}

function Route({ template }: { template: string }): null {
  useOuoRoute(template);
  return null;
}

describe("@ouo11y/browser/react", () => {
  it("OuoErrorBoundary reports the render error once, handled, with the component stack, and renders the fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 100 } });
    const onError = vi.fn();
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(OuoErrorBoundary, { fallback: createElement("p", null, "Something went wrong"), attributes: { plan: "pro" }, onError }, createElement(Bomb)));
    });
    expect(document.body.textContent).toContain("Something went wrong");
    expect(onError).toHaveBeenCalledTimes(1);
    await ouo.flush();
    await collector.settled();
    // React in development also rethrows the error to `window`; a production build reports it once.
    const ex = collector.events("exception").filter((e) => e.attributes["ouo.exception.source"] === "manual");
    expect(ex).toHaveLength(1);
    expect(ex[0]!.attributes).toMatchObject({ "exception.message": "render failed", "ouo.exception.source": "manual", "ouo.exception.handled": true, plan: "pro" });
    expect(String(ex[0]!.attributes["ouo.react.component_stack"])).toContain("Bomb");
    act(() => root.unmount());
  });

  it("works without the SDK running: the boundary still renders its fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(OuoErrorBoundary, { fallback: ({ error }: { error: unknown }) => createElement("p", null, String((error as Error).message)) }, createElement(Bomb)));
    });
    expect(document.body.textContent).toContain("render failed");
    act(() => root.unmount());
  });

  it("useOuoRoute names the view the History API reported, without a second navigation", async () => {
    ouo.init({ endpoint: BASE, serviceName: "web-store", transport: { flushIntervalMs: 100 } });
    const root = createRoot(document.getElementById("root")!);
    history.pushState(null, "", "/products/42");
    await act(async () => {
      root.render(createElement(Route, { template: routeTemplate([{ route: { path: "/" } }, { route: { path: "products/:id" } }])! }));
    });
    ouo.recordEvent("cart.add");
    await ouo.flush();
    await collector.settled();
    expect(collector.events("browser.navigation")).toHaveLength(2);
    expect(collector.events("cart.add")[0]!.attributes["ouo.view.name"]).toBe("/products/:id");
    act(() => root.unmount());
  });

  it("routeTemplate joins matched route paths", () => {
    expect(routeTemplate([{ route: { path: "/" } }, { route: { path: "products/:id" } }])).toBe("/products/:id");
    expect(routeTemplate([{ route: { path: "/a" } }, { route: { path: "/b/:c" } }])).toBe("/b/:c");
    expect(routeTemplate([])).toBeUndefined();
    expect(routeTemplate(null)).toBeUndefined();
  });
});
