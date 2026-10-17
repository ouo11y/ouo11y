// The app's own monitoring calls, sent to whichever SDKs this launch runs (src/rollout.ts).
// Direct Sentry.* calls do nothing in `ouo` mode, so calls that matter in every cohort go
// through here. Automatic capture (errors, fetch, sessions, replay) needs nothing.
import { ouo } from "./ouo";
import { Sentry } from "./sentry";
import type { RumMode } from "./rollout";

let mode: RumMode = "sentry";

export function setMode(m: RumMode): void {
  mode = m;
}

export function currentMode(): RumMode {
  return mode;
}

/** Handled exception: a Sentry event and an ouo `exception` record. Returns the Sentry event id, if any. */
export function captureException(error: unknown, tags: Record<string, string> = {}): string | undefined {
  ouo?.captureError(error, tags);
  return mode === "ouo" ? undefined : Sentry.captureException(error, { tags });
}

/** Informational message: a Sentry `info` event and an ouo custom event. */
export function captureMessage(message: string, attrs: Record<string, string> = {}): string | undefined {
  ouo?.addEvent("app.message", { message, ...attrs });
  return mode === "ouo" ? undefined : Sentry.captureMessage(message, "info");
}

export async function flush(): Promise<boolean> {
  const [s] = await Promise.all([mode === "ouo" ? Promise.resolve(true) : Sentry.flush(), ouo?.flush()]);
  return s;
}
