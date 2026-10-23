import { ROOT_CONTEXT, type Context, type ContextManager } from "@opentelemetry/api";

/**
 * Synchronous context manager: `context.with(ctx, fn)` makes `ctx` active while `fn` runs.
 * Hermes has no AsyncLocalStorage or zone, so the context does not survive an `await`; code
 * after an await passes the span explicitly (`startSpan(name, { parent })`). Enough for
 * `withSpan`, for requests started synchronously inside it and for logs and errors emitted there.
 */
export class StackContextManager implements ContextManager {
  private current: Context = ROOT_CONTEXT;

  active(): Context {
    return this.current;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    const previous = this.current;
    this.current = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.current = previous;
    }
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== "function") return target;
    const fn = target as unknown as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return function bound(this: unknown, ...a: unknown[]) {
      return manager.with(ctx, () => fn.apply(this, a));
    } as unknown as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.current = ROOT_CONTEXT;
    return this;
  }
}
