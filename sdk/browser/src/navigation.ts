import { attempt, guard } from "./guard";
import type { EventEmitter } from "./telemetry/events";
import type { InteractionTracker } from "./interactions/tracker";

export const SOFT_NAVIGATION_SPAN = "soft-navigation";

export interface NavigationOptions {
  events: EventEmitter;
  onActivity: () => void;
  /** When set, every SPA route change opens a `soft-navigation` span that ends when the page settles. */
  tracker?: InteractionTracker | undefined;
}

/**
 * Patches history.pushState / replaceState and listens to popstate, emitting `navigation` events.
 * The patched methods call the original first and return its result; an exception the original
 * throws (a SecurityError for a cross-origin URL) reaches the caller unchanged, and nothing the
 * SDK does afterwards can throw.
 */
export function installNavigation(opts: NavigationOptions): () => void {
  const { events, onActivity, tracker } = opts;
  let current = location.pathname;

  const emit = guard((kind: string): void => {
    const next = location.pathname;
    if (next === current && kind !== "load") return;
    const attrs = {
      "url.path": next,
      "url.full": location.href,
      "ouo.navigation.from": current,
      "ouo.navigation.kind": kind,
    };
    events.emit("navigation", attrs);
    // Soft-navigation timing: from the route change until requests and DOM mutations settle,
    // under the click that caused it when there is one.
    const click = tracker?.current("click");
    tracker?.begin("navigation", SOFT_NAVIGATION_SPAN, attrs, click && !click.detached ? { parent: click.context } : {});
    current = next;
    onActivity();
  });

  const history = globalThis.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  let active = true;
  const patchedPush = function ouoPushState(this: History, ...args: Parameters<History["pushState"]>): void {
    const r = originalPush.apply(this, args);
    if (active) emit("push");
    return r;
  };
  const patchedReplace = function ouoReplaceState(this: History, ...args: Parameters<History["replaceState"]>): void {
    const r = originalReplace.apply(this, args);
    if (active) emit("replace");
    return r;
  };
  // A frozen or non-writable history (some sandboxes) is left alone: no soft navigations then.
  attempt(() => {
    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
  });
  const onPop = guard((): void => emit("pop"));
  globalThis.addEventListener("popstate", onPop);

  // Initial page view: `from` is the referrer path when it exists.
  let from = "";
  try {
    if (document.referrer) from = new URL(document.referrer).pathname;
  } catch {
    from = "";
  }
  attempt(() =>
    events.emit("navigation", {
      "url.path": current,
      "url.full": location.href,
      "ouo.navigation.from": from,
      "ouo.navigation.kind": "load",
    }),
  );

  return () => {
    active = false;
    // Restore only what is still ours: a router that wrapped history after the SDK keeps its
    // wrapper, which calls ours, which is now a pass-through.
    attempt(() => {
      if (history.pushState === patchedPush) history.pushState = originalPush;
      if (history.replaceState === patchedReplace) history.replaceState = originalReplace;
    });
    globalThis.removeEventListener("popstate", onPop);
  };
}
