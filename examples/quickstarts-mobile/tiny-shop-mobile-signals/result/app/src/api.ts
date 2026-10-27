// The Tiny Shop API, with plain fetch. Sentry's fetch instrumentation records an http.client
// span for each request and adds sentry-trace, baggage and traceparent to it.
import { startNewTrace } from "@sentry/core";
import { Sentry } from "./sentry";
import { API_URL } from "./config";
import { navigationReady } from "./navigation";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  // A request that starts before the first screen's transaction exists would carry a parent
  // span id that no span has: wait the few ms until navigation is ready.
  await navigationReady;
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: init.json === undefined ? {} : { "content-type": "application/json" },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

// A tap that does work: its own trace and its own `ui.action` transaction, so its requests
// are children of a span (never orphans) and its frames and stalls are measured.
export function action<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));
}

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
