// @vitest-environment node
/** LIF-9, GR-CFG-5: on a server or any runtime without a DOM the SDK is a no-op and importing it touches nothing. */
import { describe, expect, it } from "vitest";

describe("server-side import", () => {
  it("imports without a DOM and every function is a silent no-op", async () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    const ouo = await import("../src/index");
    expect(() => {
      ouo.init({ endpoint: "https://otel.test", serviceName: "ssr" });
      ouo.recordEvent("x");
      ouo.recordException(new Error("x"));
      ouo.setUser("u");
      ouo.setConsent({ telemetry: true, replay: true });
      ouo.trackNavigation("/x");
      ouo.replay.start();
      ouo.replay.capture();
      ouo.getTracerProvider().getTracer("t").startSpan("s").end();
      ouo.getLoggerProvider().getLogger("l").emit({ body: "b" });
    }).not.toThrow();
    expect(ouo.getSessionId()).toBeUndefined();
    expect(ouo.diagnostics().state).toBe("off");
    await expect(ouo.flush()).resolves.toBeUndefined();
    await expect(ouo.shutdown()).resolves.toBeUndefined();
  });

  it("the React entry imports on the server too", async () => {
    const react = await import("../src/react/index");
    expect(typeof react.OuoErrorBoundary).toBe("function");
    expect(react.routeTemplate([{ route: { path: "/" } }, { route: { path: "products/:id" } }])).toBe("/products/:id");
  });
});
