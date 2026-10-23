/**
 * Interaction tracing, soft navigations, rage and dead clicks and setRoute through the public
 * API in jsdom with a stubbed fetch, asserted on the OTLP payloads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initRUM, type RUM } from "../src/index";
import { stubFetch, wait } from "./helpers/otlp";

const BASE = "http://localhost:8091";
const API = "http://localhost:8083";
const { captured, logRecords, spans } = stubFetch(BASE);
let rum: RUM & { _uninstall?: () => Promise<void> };

function button(id: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.textContent = `Do ${id}`;
  if (onClick) b.addEventListener("click", onClick);
  document.body.appendChild(b);
  return b;
}

// Fetch span end (300 ms resource-timing wait) + idle timeout (100 ms) + slack.
const settle = async (): Promise<void> => {
  await wait(700);
  await rum.flush();
};

beforeAll(() => {
  localStorage.clear();
  rum = initRUM({
    endpoint: BASE,
    projectId: "web-store",
    projectToken: "pt_test_interactions",
    service: { name: "web-store", version: "1.0.0", environment: "test" },
    tracing: { propagateTo: [new RegExp(`^${API}`)], idleTimeoutMs: 100, documentLoad: false },
    replay: { enabled: false },
  });
});

afterAll(async () => {
  await rum._uninstall?.();
});

describe("interaction tracing", () => {
  it("a click span parents the fetch its handler sends after an await", async () => {
    button("buy", () => {
      void (async () => {
        await Promise.resolve();
        await wait(10);
        await fetch(`${API}/api/checkout`, { method: "POST" });
      })();
    }).click();
    await settle();
    const fetchSpan = spans().find((s) => s.attributes["url.full"] === `${API}/api/checkout`)!;
    const click = spans().find((s) => s.name === "click" && s.attributes["app.widget.id"] === "button#buy")!;
    expect(click).toBeDefined();
    expect(fetchSpan.parentSpanId).toBe(click.spanId);
    expect(fetchSpan.traceId).toBe(click.traceId);
    expect(click.parentSpanId ?? "").toBe("");
    expect(click.attributes["app.widget.name"]).toBe("Do buy");
    expect(click.attributes["ouo.interaction.type"]).toBe("click");
    expect(click.attributes["ouo.interaction.end_reason"]).toBe("idle");
    expect(click.attributes["session.id"]).toBe(rum.session.id());
    // The click ends at its last activity (the fetch span's end), not when the idle timer fired.
    expect(BigInt(click.endTimeUnixNano)).toBe(BigInt(fetchSpan.endTimeUnixNano));
    const req = captured.find((c) => c.url === `${API}/api/checkout`)!;
    expect(req.headers["traceparent"]).toContain(click.traceId);
  });

  it("a route change opens a soft-navigation span under the click, parenting the new route's fetch", async () => {
    button("open-product", () => {
      history.pushState({}, "", "/products/7");
      rum.setRoute("/products/:id");
      setTimeout(() => void fetch(`${API}/api/products/7`), 20);
    }).click();
    await settle();
    const click = spans().find((s) => s.name === "click" && s.attributes["app.widget.id"] === "button#open-product")!;
    const nav = spans().find((s) => s.name === "soft-navigation" && s.attributes["url.path"] === "/products/7")!;
    const fetchSpan = spans().find((s) => s.attributes["url.full"] === `${API}/api/products/7`)!;
    expect(nav.parentSpanId).toBe(click.spanId);
    expect(fetchSpan.parentSpanId).toBe(nav.spanId);
    expect(nav.attributes["ouo.navigation.kind"]).toBe("push");
    expect(nav.attributes["ouo.navigation.from"]).toBe("/");
    expect(nav.attributes["app.screen.name"]).toBe("/products/:id");
    expect(fetchSpan.attributes["app.screen.name"]).toBe("/products/:id");
    // The navigation event is written before the route renders and has no route name.
    const navEvent = logRecords().find((r) => r.eventName === "navigation" && r.attributes["url.path"] === "/products/7")!;
    expect(navEvent.attributes["app.screen.name"]).toBeUndefined();
  });

  it("a click that changes nothing is a dead click and its span is not exported", async () => {
    button("dead").click();
    await settle();
    const dead = logRecords().filter((r) => r.eventName === "ouo.dead_click");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attributes["app.widget.id"]).toBe("button#dead");
    expect(dead[0]!.attributes["url.path"]).toBe("/products/7");
    expect(spans().some((s) => s.name === "click" && s.attributes["app.widget.id"] === "button#dead")).toBe(false);
    // Events are emitted in the root context: no trace id from the dropped click span.
    expect(dead[0]!.traceId ?? "").toBe("");
  });

  it("a click that only changes the DOM is neither dead nor exported", async () => {
    button("toggle", (e) => ((e.currentTarget as HTMLElement).dataset["open"] = "1")).click();
    await settle();
    expect(logRecords().some((r) => r.eventName === "ouo.dead_click" && r.attributes["app.widget.id"] === "button#toggle")).toBe(false);
    expect(spans().some((s) => s.attributes["app.widget.id"] === "button#toggle")).toBe(false);
  });

  it("three quick clicks on one element are one rage click", async () => {
    const b = button("rage");
    b.click();
    b.click();
    b.click();
    await wait(1200);
    await rum.flush();
    const rage = logRecords().filter((r) => r.eventName === "ouo.rage_click");
    expect(rage).toHaveLength(1);
    expect(rage[0]!.attributes["ouo.click.count"]).toBe(3);
    expect(rage[0]!.attributes["app.widget.id"]).toBe("button#rage");
    // Only the last click of the burst can be dead: the earlier ones were superseded.
    expect(logRecords().filter((r) => r.eventName === "ouo.dead_click" && r.attributes["app.widget.id"] === "button#rage")).toHaveLength(1);
  });

  it("a link whose navigation is not prevented is never a dead click", async () => {
    const a = document.createElement("a");
    a.href = "#elsewhere";
    a.id = "plain-link";
    a.textContent = "elsewhere";
    document.body.appendChild(a);
    a.click();
    await settle();
    expect(logRecords().some((r) => r.eventName === "ouo.dead_click" && r.attributes["app.widget.id"] === "a#plain-link")).toBe(false);
  });
});
