/**
 * Diagnostics (ERR-8): the console, only when `debug` is on, and never a record payload, an
 * attribute value or any part of a credential. Callers pass short fixed messages, numbers and
 * error objects only.
 */
export interface DebugLogger {
  enabled: boolean;
  log(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export const silentLogger: DebugLogger = { enabled: false, log: () => undefined, warn: () => undefined };

export function createLogger(enabled: boolean): DebugLogger {
  if (!enabled) return silentLogger;
  const out = (fn: "log" | "warn", message: string, detail: unknown): void => {
    try {
      // console.warn at most: the SDK never calls console.error.
      if (detail === undefined) console[fn]("[ouo]", message);
      else console[fn]("[ouo]", message, detail instanceof Error ? `${detail.name}: ${detail.message}` : detail);
    } catch {
      // A replaced or broken console is not the SDK's problem.
    }
  };
  return {
    enabled: true,
    log: (message, detail) => out("log", message, detail),
    warn: (message, detail) => out("warn", message, detail),
  };
}
