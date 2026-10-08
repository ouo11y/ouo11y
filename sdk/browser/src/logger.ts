export interface DebugLogger {
  enabled: boolean;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

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
