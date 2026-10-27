// The Tiny Shop API. Sentry's fetch instrumentation makes each call an http.client span and adds
// sentry-trace, baggage and traceparent, so the API's spans join the app's trace.
import { startNewTrace } from "@sentry/core";
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import { navigationReady, navigationRef } from "./navigation";

export type Product = { id: number; name: string; price: number; description: string };
export type Order = { ok: boolean; orderId: number };

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

// A request needs a span around it. Without one, Sentry still sends a traceparent, but with a
// parent span id that no span has and the "not sampled" flag: the API drops its spans.
// - The first screen loads before the navigation container is ready: wait (a few ms) so the
//   request belongs to the screen's transaction.
// - A tap gets its own trace and transaction, named after what the user did.
async function inScreen<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigationRef.isReady()) await navigationReady;
  if (Sentry.getActiveSpan()) return run();
  return tap(name, run);
}

// startNewTrace: without it every tap reuses the trace id of the last screen change.
export function tap<T>(name: string, run: () => Promise<T>): Promise<T> {
  return startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, run));
}

export const getProducts = () => inScreen("Load products", () => request<Product[]>("GET", "/api/products"));
export const checkout = (items: { id: number; qty: number }[]) =>
  tap("Checkout", () => request<Order>("POST", "/api/checkout", { items }));
export const callBrokenApi = () => tap("Call broken API", () => request<unknown>("GET", "/api/fail"));

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
