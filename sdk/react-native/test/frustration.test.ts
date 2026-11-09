/**
 * Rage and dead taps (docs/specs/mobile-sdk.md C6): the detector on its own, the commit probe, and
 * the records end to end through initRUM and RUMProvider.
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCommitProbe, installCommitProbe } from "../src/commits";
import { createTapFrustration, DEAD_CLICK_EVENT, RAGE_CLICK_EVENT, type Tap } from "../src/frustration";
import { initRUM, RUMProvider, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import type { EventEmitter } from "../src/telemetry/events";
import { attr, baseOptions, g, installErrorUtils, installFetchStub } from "./support/otlp";

type Emitted = { name: string; attrs: Record<string, unknown>; severity: string; ts: number; body: unknown };

function detector(over: { rage?: false; dead?: false; live?: boolean } = {}) {
  const emitted: Emitted[] = [];
  const events = { emit: (name: string, attrs: Record<string, unknown>, severity: string, ts: number, o?: { body?: unknown }) => emitted.push({ name, attrs, severity, ts, body: o?.body }) } as unknown as EventEmitter;
  let commits = 0;
  const f = createTapFrustration({
    events,
    rage: over.rage === false ? false : { threshold: 3, windowMs: 1000, radiusPt: 30 },
    dead: over.dead === false ? false : { timeoutMs: 1000 },
    commits: { count: () => commits, live: () => over.live !== false },
  });
  return { f, emitted, commit: () => commits++ };
}

const tap = (over: Partial<Tap> = {}): Tap => ({ target: "add-to-cart", viewType: "button", gesture: "tap", screen: "Products", at: Date.now(), x: 100, y: 200, optedOut: false, ...over });

describe("rage taps", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("three taps on one target within 1 s: one event at the first tap, with count and duration, identity only", () => {
    const { f, emitted } = detector({ dead: false });
    const t0 = Date.now();
    f.onTap(tap());
    vi.advanceTimersByTime(250);
    f.onTap(tap({ x: 300 })); // same target, elsewhere on it
    vi.advanceTimersByTime(250);
    f.onTap(tap());
    vi.advanceTimersByTime(250);
    f.onTap(tap());
    expect(emitted).toHaveLength(0); // the burst is still open
    vi.advanceTimersByTime(300);
    expect(emitted).toEqual([
      {
        name: RAGE_CLICK_EVENT,
        attrs: { "app.widget.id": "add-to-cart", "app.screen.coordinate.x": 100, "app.screen.coordinate.y": 200, "ouo.ui.view_type": "button", "app.screen.name": "Products", "ouo.click.count": 4, "ouo.click.duration_ms": 750 },
        severity: "warn",
        ts: t0,
        body: "Rage tap on add-to-cart (button) on Products: 4 taps in 0.8 s",
      },
    ]);
  });

  it("another target within 30 pt counts; farther, after the window, or two taps is no rage", () => {
    const near = detector({ dead: false });
    near.f.onTap(tap({ target: "a" }));
    near.f.onTap(tap({ target: "b", x: 120 }));
    near.f.onTap(tap({ target: "c", y: 220 }));
    vi.advanceTimersByTime(1000);
    expect(near.emitted.map((e) => e.attrs["ouo.click.count"])).toEqual([3]);

    const far = detector({ dead: false });
    far.f.onTap(tap({ target: "a" }));
    far.f.onTap(tap({ target: "b", x: 200 }));
    far.f.onTap(tap({ target: "a" }));
    vi.advanceTimersByTime(1000);
    expect(far.emitted).toHaveLength(0);

    const slow = detector({ dead: false });
    slow.f.onTap(tap());
    vi.advanceTimersByTime(600);
    slow.f.onTap(tap());
    vi.advanceTimersByTime(600); // the window closed: a new burst
    slow.f.onTap(tap());
    vi.advanceTimersByTime(1000);
    expect(slow.emitted).toHaveLength(0);
  });

  it("long presses and swipes are not taps and end a burst; an opted-out control has none", () => {
    const { f, emitted } = detector({ dead: false });
    f.onTap(tap());
    f.onTap(tap());
    f.onTap(tap({ gesture: "swipe" }));
    f.onTap(tap());
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
    for (let i = 0; i < 5; i++) f.onTap(tap({ optedOut: true }));
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });
});

describe("dead taps", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("a tap on a control and nothing within 1 s: one event at the tap", () => {
    const { f, emitted } = detector({ rage: false });
    const t0 = Date.now();
    f.onTap(tap({ target: "pay", viewType: "TouchableOpacity", screen: "Cart" }));
    vi.advanceTimersByTime(999);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual([
      {
        name: DEAD_CLICK_EVENT,
        attrs: { "app.widget.id": "pay", "app.screen.coordinate.x": 100, "app.screen.coordinate.y": 200, "ouo.ui.view_type": "TouchableOpacity", "app.screen.name": "Cart" },
        severity: "warn",
        ts: t0,
        body: "Dead tap on pay (TouchableOpacity) on Cart",
      },
    ]);
  });

  it("not dead after a UI commit, a navigation, a request or a move to the background", () => {
    const { f, emitted, commit } = detector({ rage: false });
    f.onTap(tap());
    vi.advanceTimersByTime(400);
    commit(); // the screen changed
    f.onTap(tap({ target: "next" }));
    vi.advanceTimersByTime(400);
    f.responded(); // a navigation, a request, the background
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });

  it("only controls, only taps, never opted out, and off until the commit probe saw a commit", () => {
    const { f, emitted } = detector({ rage: false });
    f.onTap(tap({ viewType: "Text" }));
    f.onTap(tap({ viewType: "FlatList" }));
    f.onTap(tap({ viewType: undefined }));
    f.onTap(tap({ gesture: "long_press" }));
    f.onTap(tap({ optedOut: true }));
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
    const blind = detector({ rage: false, live: false });
    blind.f.onTap(tap());
    vi.advanceTimersByTime(1000);
    expect(blind.emitted).toHaveLength(0);
  });
});

describe("commit probe", () => {
  type Manager = { completeRoot: (...a: unknown[]) => unknown; createNode: () => string };
  const ui = () => (g as { nativeFabricUIManager?: Manager }).nativeFabricUIManager;
  afterEach(() => {
    delete (g as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
    _resetCommitProbe();
  });

  it("the renderer loading meanwhile keeps a counting completeRoot; the global is the original again", () => {
    const calls: unknown[][] = [];
    const manager: Manager = { completeRoot: (...a) => calls.push(a), createNode: () => "node" };
    (g as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = manager;
    // What ReactFabric does when it loads: destructure the global.
    let renderer: Pick<Manager, "completeRoot" | "createNode"> | undefined;
    const probe = installCommitProbe(() => {
      const { completeRoot, createNode } = ui()!;
      renderer = { completeRoot, createNode };
    });
    expect(ui()).toBe(manager); // native code reads the host object back (NativeDOM)
    expect(probe.live()).toBe(false);
    expect(renderer!.createNode()).toBe("node");
    renderer!.completeRoot(1, "children");
    expect(calls).toEqual([[1, "children"]]);
    expect([probe.count(), probe.live()]).toEqual([1, true]);
    manager.completeRoot(2); // a direct call is not the renderer's
    expect(probe.count()).toBe(1);
    expect(installCommitProbe(() => expect.unreachable())).toBe(probe); // once per runtime
  });

  it("a renderer that loaded before, or one that throws, leaves no signal and the global intact", () => {
    const manager: Manager = { completeRoot: () => {}, createNode: () => "node" };
    (g as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = manager;
    const probe = installCommitProbe(() => {
      throw new Error("renderer failed");
    });
    expect(ui()).toBe(manager);
    manager.completeRoot();
    expect([probe.count(), probe.live()]).toEqual([0, false]);
  });

  it("no Fabric (old architecture, tests): no signal", () => {
    const probe = installCommitProbe();
    expect([probe.count(), probe.live()]).toEqual([0, false]);
  });
});

describe("rage and dead taps through initRUM", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installErrorUtils();
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.ErrorUtils;
    delete g.__ouoSessionProcessState;
    delete (g as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
    _resetCommitProbe();
  });

  type Handlers = { onTouchStart: (e: object) => void; onTouchEnd: (e: object) => void };
  const fiber = (props: Record<string, unknown>) => ({ elementType: "RCTView", memoizedProps: props, return: { elementType: { displayName: "Pressable" }, memoizedProps: props, return: null } });

  it("a rage burst and a dead tap from the provider's touches; a commit or a request answers a tap", async () => {
    (g as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = { completeRoot: () => {} };
    // The renderer loads while the probe is in (on a device, initRUM makes it load).
    let renderer: { completeRoot: () => void } | undefined;
    installCommitProbe(() => {
      renderer = { completeRoot: (g as { nativeFabricUIManager: { completeRoot: () => void } }).nativeFabricUIManager.completeRoot };
    });
    const captured = installFetchStub();
    const rum = initRUM(baseOptions()) as RUMInternal;
    await rum.ready;
    renderer!.completeRoot(); // the first render
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    const touch = (props: Record<string, unknown>, x = 10, y = 20) => {
      el.props.onTouchStart({ _targetInst: fiber(props), nativeEvent: { pageX: x, pageY: y } });
      el.props.onTouchEnd({ nativeEvent: { pageX: x, pageY: y } });
    };
    rum.trackNavigation("/Cart");
    for (let i = 0; i < 3; i++) touch({ testID: "pay", role: "button" });
    touch({ testID: "dead-button", role: "button" }, 300, 400);
    touch({ testID: "stepper-plus", role: "button", "ouo-frustration": false }, 300, 600);
    await new Promise((r) => setTimeout(r, 1100));
    await rum.flush();
    const rage = captured.byName(RAGE_CLICK_EVENT);
    expect(rage.map((l) => [attr(l.attributes, "app.widget.id"), attr(l.attributes, "ouo.click.count"), attr(l.attributes, "app.screen.name"), l.severityText])).toEqual([["pay", 3, "Cart", "WARN"]]);
    // All four on controls, no commit and no request after them: dead (the opted-out one is not).
    expect(captured.byName(DEAD_CLICK_EVENT).map((l) => attr(l.attributes, "app.widget.id"))).toEqual(["pay", "pay", "pay", "dead-button"]);

    touch({ testID: "save", role: "button" });
    renderer!.completeRoot();
    touch({ testID: "load", role: "button" });
    await fetch("http://backend.test/api/products");
    await new Promise((r) => setTimeout(r, 1100));
    await rum.flush();
    expect(captured.byName(DEAD_CLICK_EVENT)).toHaveLength(4);
  });
});
