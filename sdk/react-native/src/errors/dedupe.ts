import { serializeError } from "./classify";

/** How long a fatal error suppresses its own echoes (LogBox's console.error, a React dev re-throw). */
export const FATAL_ECHO_WINDOW_MS = 5000;

/**
 * Remembers the errors already reported, so one error reaching several hooks is one `exception`
 * (checklist Q1, G6):
 * - by identity: the same Error object through the global handler, console.error (React logs the
 *   error it caught), the Sentry client hook (ouo chains to Sentry's handler, which captures it);
 * - after a fatal: React Native's dev handler prints the fatal again through console.error
 *   (`Error: <message>`), and React dev can re-throw a render error as a new object with the same
 *   message. Those echoes arrived after the crashed session's `session.end` and counted a second
 *   error, or a second crash (`crash_count 2`).
 */
export class ReportedErrors {
  private readonly seen = new WeakSet<object>();
  private fatal: { type: string; message: string; at: number } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  has(error: unknown): boolean {
    return !!error && typeof error === "object" && this.seen.has(error);
  }

  /** Records `error`; false when it was reported before (by identity). */
  add(error: unknown): boolean {
    if (!error || typeof error !== "object") return true;
    if (this.seen.has(error)) return false;
    this.seen.add(error);
    return true;
  }

  markFatal(error: unknown): void {
    const s = serializeError(error);
    this.fatal = { type: s.type, message: s.message, at: this.now() };
  }

  /** A fatal with the same type and message as the one just reported. */
  isFatalRepeat(error: unknown): boolean {
    const f = this.recentFatal();
    if (!f) return false;
    const s = serializeError(error);
    return s.type === f.type && s.message === f.message;
  }

  /** A console line that prints the fatal just reported (`Error: <message>`, or the message inside a longer text). */
  isFatalEcho(consoleMessage: string): boolean {
    const f = this.recentFatal();
    if (!f || !f.message) return false;
    return consoleMessage.includes(f.message);
  }

  private recentFatal(): { type: string; message: string; at: number } | undefined {
    const f = this.fatal;
    if (!f) return undefined;
    if (this.now() - f.at > FATAL_ECHO_WINDOW_MS) {
      this.fatal = undefined;
      return undefined;
    }
    return f;
  }
}
