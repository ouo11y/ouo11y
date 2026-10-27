// The Tiny Shop API, with plain fetch. Sentry's fetch instrumentation turns each call into an
// `http.client` span and adds `sentry-trace`, `baggage` and `traceparent` to it.
import { startNewTrace } from "@sentry/core";
import { API_URL } from "./config";
import { navigationReady } from "./navigation";
import { Sentry } from "./sentry";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

// The first screen loads its products on mount, inside Sentry's first navigation transaction.
export async function getProducts(): Promise<Product[]> {
  await navigationReady;
  return request<Product[]>("/api/products");
}

export const checkout = (items: number[]) =>
  request<{ ok: boolean; orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });

export const callBrokenApi = () => request<unknown>("/api/fail");

// A tap that calls the API: its own trace (startNewTrace) and its own transaction. Without it, a
// request after the screen's transaction ended has no active span, and Sentry sends a
// `traceparent` whose parent span no span has: the API's spans would hang off a missing parent.
export const tap = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));
