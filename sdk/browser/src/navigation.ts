import type { EventEmitter } from "./telemetry/events";
import type { InteractionTracker } from "./interactions/tracker";

export const SOFT_NAVIGATION_SPAN = "soft-navigation";

export interface NavigationOptions {
  events: EventEmitter;
  onActivity: () => void;
  /** When set, every SPA route change opens a `soft-navigation` span that ends when the page settles. */
  tracker?: InteractionTracker | undefined;
}

/** Patches history.pushState / replaceState and listens to popstate, emitting `navigation` events. */
export function installNavigation(opts: NavigationOptions): () => void {
  const { events, onActivity, tracker } = opts;
  let current = location.pathname;

  const emit = (kind: string): void => {
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
  };

  const history = globalThis.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function ouoPushState(this: History, ...args: Parameters<History["pushState"]>): void {
    originalPush.apply(this, args);
    emit("push");
  };
  history.replaceState = function ouoReplaceState(this: History, ...args: Parameters<History["replaceState"]>): void {
    originalReplace.apply(this, args);
    emit("replace");
  };
  const onPop = (): void => emit("pop");
  globalThis.addEventListener("popstate", onPop);

  // Initial page view: `from` is the referrer path when it exists.
  let from = "";
  try {
    if (document.referrer) from = new URL(document.referrer).pathname;
  } catch {
    from = "";
  }
  events.emit("navigation", {
    "url.path": current,
    "url.full": location.href,
    "ouo.navigation.from": from,
    "ouo.navigation.kind": "load",
  });

  return () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    globalThis.removeEventListener("popstate", onPop);
  };
}
