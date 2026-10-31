// The app's own monitoring calls, sent to whichever SDKs this launch runs (src/rollout.ts).
// Direct Sentry.* calls do nothing in `ouo` mode, so calls that matter in every cohort go
// through here. Automatic capture (errors, fetch, sessions, replay) needs nothing.
import { createEnvelope, type EventEnvelope } from "@sentry/core";
import { ouo } from "./ouo";
import { Sentry } from "./sentry";
import type { LaunchMode } from "./rollout";

let mode: LaunchMode = "sentry";

export function setMode(m: LaunchMode): void {
  mode = m;
}

export function currentMode(): LaunchMode {
  return mode;
}

/** Handled exception: a Sentry event and an ouo `exception` record. Returns the Sentry event id, if any. */
export function captureException(error: unknown, tags: Record<string, string> = {}): string | undefined {
  ouo?.captureError(error, tags);
  return mode === "sentry" || mode === "parallel" ? Sentry.captureException(error, { tags }) : undefined;
}

/** Informational message: a Sentry `info` event and an ouo custom event. */
export function captureMessage(message: string, attrs: Record<string, string> = {}): string | undefined {
  ouo?.addEvent("app.message", { message, ...attrs });
  return mode === "sentry" || mode === "parallel" ? Sentry.captureMessage(message, "info") : undefined;
}

/** User feedback: a Sentry `feedback` event (`Sentry.captureFeedback`) and an ouo `feedback` record. */
export function captureFeedback(message: string, contact: string): string | undefined {
  ouo?.feedback({ message, contact });
  return mode === "sentry" || mode === "parallel" ? Sentry.captureFeedback({ message, email: contact, name: "QA" }) : undefined;
}

/**
 * A legacy `user_report` envelope item naming the error the user saw: what `captureUserFeedback`
 * sent before @sentry/react-native 8 removed it (older apps and sentry-cocoa's
 * `capture(userFeedback:)` still send it). Built by hand; Sentry only, ouo has no such record.
 */
export function sendUserReport(eventId: string, comments: string, email: string): void {
  if (mode !== "sentry" && mode !== "parallel") return;
  const report = { event_id: eventId, name: "QA", email, comments };
  void Sentry.getClient()?.sendEnvelope(createEnvelope<EventEnvelope>({ event_id: eventId, sent_at: new Date().toISOString() }, [[{ type: "user_report" }, report]]));
}

export async function flush(): Promise<boolean> {
  const [s] = await Promise.all([mode === "sentry" || mode === "parallel" ? Sentry.flush() : Promise.resolve(true), ouo?.flush()]);
  return s;
}
