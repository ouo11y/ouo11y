import type { Attrs } from "./types";

/** Minimal shape of a react-navigation state object (no dependency on the package). */
export interface NavigationStateLike {
  index?: number;
  routes?: Array<{ name: string; state?: NavigationStateLike; params?: object }>;
}

/** Active route path of a (possibly nested) react-navigation state, for example `/Products/Product`. */
export function activeRoutePath(state: NavigationStateLike | undefined): string {
  const parts: string[] = [];
  let cursor = state;
  while (cursor && cursor.routes && cursor.routes.length > 0) {
    const route = cursor.routes[cursor.index ?? cursor.routes.length - 1];
    if (!route) break;
    parts.push(route.name);
    cursor = route.state;
  }
  return `/${parts.join("/")}`;
}

export interface NavigationTracker {
  /** `navigation` event + activity; no event when the path did not change. */
  track(path: string, attrs?: Attrs): void;
  /** Pass to `<NavigationContainer onStateChange>`. */
  onStateChange(state: NavigationStateLike | undefined): void;
  current(): string;
}

export function createNavigationTracker(emit: (attrs: Attrs) => void): NavigationTracker {
  let current = "";
  return {
    track(path, attrs = {}) {
      if (path === current) return;
      // The new screen is current while its record is emitted (the error context reads it then).
      const from = current;
      current = path;
      emit({ "url.path": path, "ouo.navigation.from": from, ...attrs });
    },
    onStateChange(state) {
      this.track(activeRoutePath(state));
    },
    current: () => current,
  };
}
