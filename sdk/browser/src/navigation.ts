import type { EventEmitter } from "./telemetry/events";

export interface NavigationOptions {
  events: EventEmitter;
  onActivity: () => void;
}

/** Patches history.pushState / replaceState and listens to popstate, emitting `navigation` events. */
export function installNavigation(opts: NavigationOptions): () => void {
  const { events, onActivity } = opts;
  let current = location.pathname;

  const emit = (kind: string): void => {
    const next = location.pathname;
    if (next === current && kind !== "load") return;
    events.emit("navigation", {
      "url.path": next,
      "url.full": location.href,
      "ouo.navigation.from": current,
      "ouo.navigation.kind": kind,
    });
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
