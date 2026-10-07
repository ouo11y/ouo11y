import { describe, expect, it } from "vitest";
import { activeRoutePath, createNavigationTracker } from "../src/navigation";

describe("navigation", () => {
  it("derives the active route path from nested react-navigation state", () => {
    expect(activeRoutePath(undefined)).toBe("/");
    expect(activeRoutePath({ index: 1, routes: [{ name: "Products" }, { name: "Product" }] })).toBe("/Product");
    expect(
      activeRoutePath({
        index: 0,
        routes: [{ name: "Root", state: { index: 1, routes: [{ name: "Cart" }, { name: "Checkout" }] } }],
      }),
    ).toBe("/Root/Checkout");
  });

  it("emits navigation events with from/to and dedupes repeats", () => {
    const emitted: Array<Record<string, unknown>> = [];
    const t = createNavigationTracker((a) => emitted.push(a));
    t.track("/Products");
    t.track("/Products");
    t.onStateChange({ index: 0, routes: [{ name: "Cart" }] });
    expect(emitted).toEqual([
      { "url.path": "/Products", "ouo.navigation.from": "" },
      { "url.path": "/Cart", "ouo.navigation.from": "/Products" },
    ]);
    expect(t.current()).toBe("/Cart");
  });
});
