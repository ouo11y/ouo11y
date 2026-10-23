import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initRUM, type RUM } from "@ouo11y/browser";
import { OuoErrorBoundary, routeTemplate, useOuoRoute } from "../src/react/index";
import { stubFetch } from "./helpers/otlp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "http://localhost:8092";
const { logRecords } = stubFetch(BASE);
let rum: RUM & { _uninstall?: () => Promise<void> };
let root: Root;
let host: HTMLElement;

beforeAll(() => {
  localStorage.clear();
  rum = initRUM({
    endpoint: BASE,
    projectId: "web-store",
    projectToken: "pt_test_react",
    service: { name: "web-store", version: "1.0.0", environment: "test" },
    tracing: { documentLoad: false },
    replay: { enabled: false },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterAll(async () => {
  act(() => root.unmount());
  await rum._uninstall?.();
});

function Boom(): never {
  throw new TypeError("render failed");
}

describe("@ouo11y/browser/react", () => {
  it("OuoErrorBoundary reports the render error with the component stack and renders the fallback", async () => {
    // React logs the caught error through console.error, which the SDK also captures.
    act(() =>
      root.render(
        createElement(
          OuoErrorBoundary,
          { fallback: ({ error }) => createElement("p", { id: "fallback" }, `failed: ${(error as Error).message}`), attributes: { area: "checkout" } },
          createElement(Boom),
        ),
      ),
    );
    expect(host.querySelector("#fallback")?.textContent).toBe("failed: render failed");
    await rum.flush();
    const ex = logRecords().filter((r) => r.eventName === "exception" && r.attributes["ouo.exception.kind"] === "react.error_boundary");
    expect(ex).toHaveLength(1);
    expect(ex[0]!.attributes["exception.type"]).toBe("TypeError");
    expect(ex[0]!.attributes["ouo.exception.fatal"]).toBe(false);
    expect(ex[0]!.attributes["ouo.exception.handled"]).toBe(true);
    expect(ex[0]!.attributes["area"]).toBe("checkout");
    expect(String(ex[0]!.attributes["ouo.react.component_stack"])).toContain("Boom");
    // React logs the caught error with console.error before componentDidCatch: that copy is not
    // reported. (React's development build also rethrows it to window: "uncaught" here, not in production.)
    const kinds = logRecords()
      .filter((r) => r.eventName === "exception" && r.attributes["exception.message"] === "render failed")
      .map((r) => r.attributes["ouo.exception.kind"]);
    expect(kinds).toContain("react.error_boundary");
    expect(kinds).not.toContain("console");
  });

  it("the fallback's reset renders the children again", () => {
    let fail = true;
    const Maybe = () => {
      if (fail) throw new Error("once");
      return createElement("p", { id: "ok" }, "ok");
    };
    let reset: () => void = () => undefined;
    act(() =>
      root.render(
        createElement(OuoErrorBoundary, { fallback: (p) => ((reset = p.reset), createElement("p", null, "failed")) }, createElement(Maybe)),
      ),
    );
    fail = false;
    act(() => reset());
    expect(host.querySelector("#ok")).not.toBeNull();
  });

  it("useOuoRoute names the route on later events", async () => {
    let setTemplate: (t: string) => void = () => undefined;
    const Page = () => {
      const [t, set] = useState("/products/:id");
      setTemplate = set;
      useOuoRoute(t);
      return null;
    };
    act(() => root.render(createElement(Page)));
    rum.addEvent("after_route", {});
    act(() => setTemplate("/cart"));
    rum.addEvent("after_cart", {});
    await rum.flush();
    expect(logRecords().find((r) => r.eventName === "after_route")!.attributes["app.screen.name"]).toBe("/products/:id");
    expect(logRecords().find((r) => r.eventName === "after_cart")!.attributes["app.screen.name"]).toBe("/cart");
  });

  it("routeTemplate joins React Router matches", () => {
    expect(routeTemplate([{ route: { path: "/" } }, { route: { path: "products/:id" } }])).toBe("/products/:id");
    expect(routeTemplate([{ route: {} }, { route: { path: "/cart/" } }])).toBe("/cart");
    expect(routeTemplate([{ route: { path: "/" } }, { route: { index: true } }])).toBe("/");
    expect(routeTemplate([{ route: { path: "/shop" } }, { route: { path: "*" } }])).toBe("/shop/*");
    expect(routeTemplate(null)).toBeUndefined();
  });
});
