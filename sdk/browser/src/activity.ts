import { guard } from "./guard";

/** Wires DOM activity sources to the session manager (spec: activity definition). */
export function installActivityListeners(onActivity: () => void): () => void {
  const types: Array<keyof WindowEventMap> = ["click", "keydown", "scroll", "touchstart", "pointerdown"];
  const handler = guard((): void => onActivity());
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const t of types) globalThis.addEventListener(t, handler, options);
  const onVisibility = guard((): void => {
    if (document.visibilityState === "visible") onActivity();
  });
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    for (const t of types) globalThis.removeEventListener(t, handler, options);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
