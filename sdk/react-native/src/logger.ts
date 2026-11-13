export interface DebugLogger {
  enabled: boolean;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Never uses console.error: the SDK instruments it and would report its own output as exceptions.
 * Silent unless `debug` is on (spec ERR-8), and a console that throws is ignored: a diagnostic
 * is never worth an error.
 */
export function createLogger(enabled: boolean): DebugLogger {
  const write = (method: "log" | "warn", args: unknown[]): void => {
    if (!enabled) return;
    try {
      console[method]("[ouo]", ...args);
    } catch {
      // a broken console
    }
  };
  return {
    enabled,
    log: (...args: unknown[]) => write("log", args),
    warn: (...args: unknown[]) => write("warn", args),
  };
}
