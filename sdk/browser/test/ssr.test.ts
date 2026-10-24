// @vitest-environment node
/**
 * Server rendering (checklist N42): importing either entry in Node without `window` or
 * `document` does not throw, `initRUM` returns an inert instance, and the React entry renders
 * on the server (what Next.js does with a client component during SSR).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

describe("server-side import and rendering", () => {
  it("has no window or document here", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("initRUM on the server is inert and does not register an instance", async () => {
    const { initRUM, getRUM } = await import("../src/index");
    const rum = initRUM({
      endpoint: "http://localhost:4318",
      projectId: "p",
      projectToken: "t",
      service: { name: "ssr", version: "1", environment: "test" },
    });
    expect(getRUM()).toBeUndefined();
    expect(rum.session.id()).toBe("");
    expect(() => rum.captureError(new Error("x"))).not.toThrow();
    await expect(rum.flush()).resolves.toBeUndefined();
    await expect(rum.shutdown()).resolves.toBeUndefined();
  });

  it("still throws on a configuration error on the server, like in the browser", async () => {
    const { initRUM } = await import("../src/index");
    expect(() => initRUM({ endpoint: "", projectId: "p", projectToken: "t", service: { name: "ssr", version: "1", environment: "test" } })).toThrow(/endpoint/);
  });

  it("the React entry renders on the server", async () => {
    const { OuoErrorBoundary, useOuoRoute } = await import("../src/react/index");
    function Page(): ReturnType<typeof createElement> {
      useOuoRoute("/products/:id");
      return createElement("p", null, "hello");
    }
    const html = renderToString(createElement(OuoErrorBoundary, { fallback: createElement("p", null, "oops") }, createElement(Page)));
    expect(html).toBe("<p>hello</p>");
  });
});
