import { describe, expect, it } from "vitest";
import { touchedComponent, type FiberLike } from "../src/taps";

/** Builds a fiber chain from the touched view up: each entry is [displayName?, props?]. */
function chain(...nodes: Array<[string | undefined, Record<string, unknown>?]>): FiberLike {
  let parent: FiberLike | null = null;
  for (const [name, props] of nodes.slice().reverse()) {
    parent = { elementType: name ? { displayName: name } : "RCTView", memoizedProps: props ?? {}, return: parent };
  }
  return parent!;
}

describe("tap targets (G4)", () => {
  it("names the first label up the tree and the path, innermost first, like Sentry's touch breadcrumb", () => {
    const fiber = chain([undefined, {}], ["Text", { children: "Pay" }], [undefined, { testID: "checkout-pay" }], ["Pressable", { testID: "checkout-pay" }], ["CartScreen"]);
    expect(touchedComponent(fiber)).toEqual({ target: "checkout-pay", path: "Text > checkout-pay > CartScreen" });
  });

  it("prefers ouo-label / sentry-label, then accessibilityLabel, aria-label, testID", () => {
    expect(touchedComponent(chain([undefined, { accessibilityLabel: "Add to cart", testID: "add" }]))?.target).toBe("Add to cart");
    expect(touchedComponent(chain([undefined, { "sentry-label": "buy", accessibilityLabel: "Buy" }]))?.target).toBe("buy");
    expect(touchedComponent(chain([undefined, { "ouo-label": "buy-ouo", "sentry-label": "buy" }]))?.target).toBe("buy-ouo");
  });

  it("falls back to the innermost component name, stops at the provider, and never reads text", () => {
    const provider = { onTouchStart: () => {} };
    const fiber = chain(["Text", { children: "secret text" }], ["ProductCard"], [undefined, provider], ["App"]);
    expect(touchedComponent(fiber, (f) => (f.memoizedProps as { onTouchStart?: unknown }).onTouchStart === provider.onTouchStart)).toEqual({
      target: "Text",
      path: "Text > ProductCard",
    });
    expect(touchedComponent(chain([undefined, {}]))).toBeUndefined();
    expect(touchedComponent(undefined)).toBeUndefined();
  });
});
