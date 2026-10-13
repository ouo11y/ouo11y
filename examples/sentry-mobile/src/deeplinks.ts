// Deep links let scripts/journey.sh drive the app without taps:
//   sentrydemo://action/<action name>          e.g. sentrydemo://action/handled-error
//   sentrydemo://screen/<home|product|cart|back>[?id=p-1002]
import * as Linking from "expo-linking";
import { runAction } from "./actions";
import { goTo, navigationRef } from "./navigation";
import { setStatus } from "./status";

export function handleUrl(url: string | null): void {
  if (!url) return;
  const { hostname, path, queryParams } = Linking.parse(url);
  const target = (path ?? "").replace(/^\/+|\/+$/g, "");
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(queryParams ?? {})) if (typeof v === "string") params[k] = v;
  if (hostname === "action") {
    runAction(target);
  } else if (hostname === "screen") {
    if (!goTo(target, params)) setStatus(`cannot open screen ${target}`);
  } else {
    setStatus(`unhandled link ${url}`);
  }
}

/** Call once the navigation container is ready. Returns the unsubscribe function. */
export function listenForLinks(): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => handleUrl(url));
  void Linking.getInitialURL().then((url) => {
    if (url && navigationRef.isReady()) handleUrl(url);
  });
  return () => sub.remove();
}
