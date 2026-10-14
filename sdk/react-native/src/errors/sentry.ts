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
