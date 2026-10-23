import type { DebugLogger } from "../logger";
import type { Attrs, SentryClientLike, SentryEventLike } from "../types";
import { exceptionAttributes } from "./classify";
import type { ReportedErrors } from "./dedupe";

/**
 * Best effort: whether a Sentry client already exists (the `__SENTRY__` carrier of @sentry/core
 * 8 to 10, read defensively). Used only to warn about the shared promise rejection tracker.
 */
export function sentryClientPresent(): boolean {
  try {
    const carrier = (globalThis as { __SENTRY__?: Record<string, unknown> }).__SENTRY__;
    if (!carrier || typeof carrier !== "object") return false;
    for (const value of Object.values(carrier)) {
      const scope = (value as { defaultCurrentScope?: { getClient?: () => unknown } } | null)?.defaultCurrentScope;
      if (scope && typeof scope.getClient === "function" && scope.getClient()) return true;
    }
  } catch {
    // unknown carrier shape
  }
  return false;
}

/** Sentry mechanisms of errors ouo captures itself: its global handler chains to Sentry's, and it forwards rejections. */
const OUO_CAPTURED_MECHANISMS = new Set(["onerror", "onunhandledrejection", "auto.function.onerror", "auto.function.onunhandledrejection"]);

/** Whether a Sentry event is an error ouo should forward (not a message, not a transaction, not ouo's own capture). */
export function forwardableSentryError(event: SentryEventLike): boolean {
  if (event.type) return false; // transaction, replay_event, feedback...
  const values = event.exception?.values ?? [];
  const last = values[values.length - 1];
  if (!last) return false;
  if (last.mechanism?.synthetic === true && event.level !== "error" && event.level !== "fatal") return false; // captureMessage
  if (last.mechanism?.type && OUO_CAPTURED_MECHANISMS.has(last.mechanism.type)) return false;
  return true;
}

/** Sentry's frames (oldest first) as a stack the SDK's normaliser reads, newest first. */
function sentryStack(event: SentryEventLike): string {
  const values = event.exception?.values ?? [];
  const last = values[values.length - 1];
  const frames = last?.stacktrace?.frames ?? [];
  const head = `${last?.type ?? "Error"}: ${last?.value ?? ""}`;
  const lines = frames
    .slice()
    .reverse()
    .map((f) => `    at ${f.function || "?"} (${f.filename ?? f.module ?? "?"}${f.lineno !== undefined ? `:${f.lineno}` : ""}${f.colno !== undefined ? `:${f.colno}` : ""})`);
  return [head, ...lines].join("\n");
}

export interface SentryForwardOptions {
  client: SentryClientLike;
  reported: ReportedErrors;
  logger: DebugLogger;
  emitException: (error: unknown, attrs: Attrs) => void;
}

/**
 * Checklist G6: next to Sentry, errors that only Sentry sees (`Sentry.captureException`,
 * `Sentry.ErrorBoundary`, Sentry integrations) become ouo `exception` records too. Hooked on the
 * client's `beforeSendEvent`, so ouo forwards exactly the error events Sentry sends. Returns the
 * unsubscribe function.
 */
export function forwardSentryErrors(opts: SentryForwardOptions): () => void {
  const { client, reported, logger } = opts;
  if (!client || typeof client.on !== "function") {
    logger.warn("errors.forwardSentryErrors: not a Sentry client (pass Sentry.getClient() after Sentry.init)");
    return () => {};
  }
  const off = client.on("beforeSendEvent", (event, hint) => {
    try {
      if (!event || !forwardableSentryError(event)) return;
      const original = hint?.originalException;
      if (original !== undefined && !reported.add(original)) return; // ouo reported this Error object already
      const values = event.exception?.values ?? [];
      const last = values[values.length - 1]!;
      const error =
        original instanceof Error
          ? original
          : { name: last.type ?? "Error", message: last.value ?? (typeof original === "string" ? original : ""), stack: sentryStack(event) };
      const extra: Attrs = {};
      if (last.mechanism?.type) extra["ouo.sentry.mechanism"] = last.mechanism.type;
      if (event.event_id) extra["ouo.sentry.event_id"] = event.event_id;
      const attrs = exceptionAttributes(error, "sentry", event.level === "fatal", extra, last.mechanism?.handled ?? true);
      opts.emitException(original ?? error, attrs);
    } catch (e) {
      logger.warn("forwarding a Sentry error failed", e);
    }
  });
  logger.log("forwarding Sentry error events");
  return typeof off === "function" ? off : () => {};
}
