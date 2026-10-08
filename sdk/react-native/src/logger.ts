export interface DebugLogger {
  enabled: boolean;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Never uses console.error: the SDK instruments it and would report its own output as exceptions. */
export function createLogger(enabled: boolean): DebugLogger {
  return {
    enabled,
    log(...args: unknown[]): void {
      if (enabled) console.log("[ouo]", ...args);
    },
    warn(...args: unknown[]): void {
      if (enabled) console.warn("[ouo]", ...args);
    },
  };
}
