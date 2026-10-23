import { AppState, type AppStateStatus } from "react-native";
import type { DebugLogger } from "./logger";

/** `ouo.app.state` values, as the Sentry bridge maps sentry-cocoa's `app.*` breadcrumbs (spec section 9a). */
export type LifecycleState = "foreground" | "inactive" | "background";

export interface AppStateHooks {
  onBackground: () => void;
  onForeground: () => void;
  /** Every change of state (not the initial one): the `app.lifecycle` timeline event. */
  onLifecycle?: (state: LifecycleState) => void;
  logger: DebugLogger;
}

const LIFECYCLE: Partial<Record<string, LifecycleState>> = { active: "foreground", inactive: "inactive", background: "background" };

/** Bridges `AppState` changes to the session manager (spec: mobile start rule 2). */
export function installAppStateListener(hooks: AppStateHooks): () => void {
  // iOS passes through `inactive` (app switcher, control centre, incoming call) in both
  // directions; only a real `background` stay starts the background clock.
  let inBackground = AppState.currentState === "background";
  let last: LifecycleState | undefined = LIFECYCLE[AppState.currentState];
  const handler = (next: AppStateStatus): void => {
    hooks.logger.log("app state", next);
    const state = LIFECYCLE[next];
    const changed = state !== undefined && state !== last;
    if (state) last = state;
    // Background: the event first, so the flush on background sends it. Foreground: after the
    // session manager, so the event lands in the replacement session after a long stay.
    if (changed && state !== "foreground") hooks.onLifecycle?.(state!);
    if (next === "background" && !inBackground) {
      inBackground = true;
      hooks.onBackground();
    } else if (next === "active" && inBackground) {
      inBackground = false;
      hooks.onForeground();
    }
    if (changed && state === "foreground") hooks.onLifecycle?.(state);
  };
  const sub = AppState.addEventListener("change", handler);
  return () => sub.remove();
}
