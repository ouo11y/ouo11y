import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";

/**
 * StackContextManager with a fallback for the root context. Browsers have no async context
 * (no zone.js, TC39 AsyncContext pending), so a `fetch` issued after an `await` inside a click
 * handler sees the root context. While an interaction or a soft navigation is open, the
 * interaction tracker supplies its span's context here and that `fetch` becomes its child.
 * An explicit `context.with(ctx, ...)` still wins.
 */
export class FallbackContextManager extends StackContextManager {
  private fallback: (() => Context | undefined) | undefined;

  setFallback(fallback: (() => Context | undefined) | undefined): void {
    this.fallback = fallback;
  }

  override active(): Context {
    const ctx = super.active();
    if (ctx !== ROOT_CONTEXT || !this.fallback) return ctx;
    return this.fallback() ?? ctx;
  }
}
