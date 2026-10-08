import { AppState, type AppStateStatus } from "react-native";
import type { DebugLogger } from "./logger";

export interface AppStateHooks {
  onBackground: () => void;
  onForeground: () => void;
  logger: DebugLogger;
}

/** Bridges `AppState` changes to the session manager (spec: mobile start rule 2). */
export function installAppStateListener(hooks: AppStateHooks): () => void {
  // iOS passes through `inactive` (app switcher, control centre, incoming call) in both
  // directions; only a real `background` stay starts the background clock.
  let inBackground = AppState.currentState === "background";
  const handler = (next: AppStateStatus): void => {
    hooks.logger.log("app state", next);
    if (next === "background" && !inBackground) {
      inBackground = true;
      hooks.onBackground();
    } else if (next === "active" && inBackground) {
      inBackground = false;
      hooks.onForeground();
    }
  };
  const sub = AppState.addEventListener("change", handler);
  return () => sub.remove();
}
