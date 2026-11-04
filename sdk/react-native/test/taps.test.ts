import { describe, expect, it } from "vitest";
import { gestureOf, LONG_PRESS_MS, SWIPE_DISTANCE, touchedComponent, type FiberLike } from "../src/taps";

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
    expect(touchedComponent(fiber)).toEqual({ target: "checkout-pay", path: "Text > checkout-pay > CartScreen", viewType: "Pressable" });
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
      viewType: "Text",
    });
    expect(touchedComponent(chain([undefined, {}]))).toBeUndefined();
    expect(touchedComponent(undefined)).toBeUndefined();
  });

  it("ouo-frustration={false} on the control or an ancestor opts the touch out of rage and dead taps", () => {
    expect(touchedComponent(chain([undefined, { testID: "plus", "ouo-frustration": false }]))).toMatchObject({ target: "plus", optedOut: true });
    expect(touchedComponent(chain([undefined, { testID: "plus" }], ["Stepper", { "ouo-frustration": false }]))?.optedOut).toBe(true);
    expect(touchedComponent(chain([undefined, { testID: "plus", "ouo-frustration": "no" }]))).not.toHaveProperty("optedOut");
  });

  it("skips React context providers and consumers", () => {
    const ctx = { $$typeof: Symbol.for("react.context"), displayName: "ThemeContext", _currentValue: {} };
    const fiber: FiberLike = {
      elementType: "RCTView",
      memoizedProps: { testID: "btn-Chaos" },
      return: { elementType: ctx, memoizedProps: { value: {} }, return: { elementType: { displayName: "Screen" }, memoizedProps: {}, return: null } },
    };
    expect(touchedComponent(fiber)).toEqual({ target: "btn-Chaos", path: "btn-Chaos > Screen", viewType: "RCTView" });
  });

  it("view type: the control's accessibility role, else the labelled component, never an ancestor outside the control", () => {
    // What RN renders for <Pressable testID role="button"><Text>Add</Text></Pressable>.
    const pressable = chain([undefined, { children: "Add" }], ["Text", { children: "Add" }], [undefined, { testID: "add-to-cart", role: "button" }], ["View", { testID: "add-to-cart", role: "button" }], ["Pressable", { testID: "add-to-cart", role: "button" }], ["ProductScreen", { accessibilityRole: "list" }]);
    expect(touchedComponent(pressable)).toMatchObject({ target: "add-to-cart", viewType: "button" });
    const touchable = chain([undefined, { testID: "pay" }], ["View", { testID: "pay" }], ["TouchableOpacity", { testID: "pay" }], ["CartScreen", { accessibilityRole: "list" }]);
    expect(touchedComponent(touchable)).toMatchObject({ target: "pay", viewType: "TouchableOpacity" });
    expect(touchedComponent(chain([undefined, { accessibilityRole: "none", testID: "x" }]))?.viewType).toBe("RCTView");
    // A context or an unnamed host view inside the control does not end it; a role outside it is not used.
    const ctx = { $$typeof: Symbol.for("react.context"), _currentValue: false };
    const wrapped: FiberLike = {
      elementType: "RCTView",
      memoizedProps: { testID: "row-1" },
      return: {
        elementType: ctx,
        memoizedProps: { value: false },
        return: {
          elementType: { displayName: "View" },
          memoizedProps: { testID: "row-1" },
          return: {
            elementType: { displayName: "Pressable" },
            memoizedProps: { testID: "row-1" },
            return: { elementType: "RCTView", memoizedProps: { role: "list" }, return: { elementType: { displayName: "List" }, memoizedProps: { role: "list" }, return: null } },
          },
        },
      },
    };
    expect(touchedComponent(wrapped)).toMatchObject({ target: "row-1", viewType: "Pressable" });
  });
});

describe("gestures (C6)", () => {
  it("a move beats a hold; a short still touch is a tap", () => {
    expect(gestureOf(80, 0, 0)).toBe("tap");
    expect(gestureOf(LONG_PRESS_MS - 1, 3, 4)).toBe("tap");
    expect(gestureOf(LONG_PRESS_MS, 0, 0)).toBe("long_press");
    expect(gestureOf(120, 0, SWIPE_DISTANCE)).toBe("swipe");
    expect(gestureOf(2000, -60, 8)).toBe("swipe");
  });
});
