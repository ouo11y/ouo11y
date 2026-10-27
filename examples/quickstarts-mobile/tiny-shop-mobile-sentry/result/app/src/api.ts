// The API client. Sentry's fetch instrumentation turns each call into an `http.client` span and
// adds `sentry-trace`, `baggage` and `traceparent` to requests to the API.
import { startNewTrace } from "@sentry/core";
import { API_URL, Sentry } from "./sentry";

export type Product = { id: number; name: string; price: number };

// Resolved when the navigation container is ready (App.tsx); Sentry's first screen span starts then.
let ready: () => void;
export const navigationReady = new Promise<void>((resolve) => (ready = resolve));
export const markNavigationReady = () => ready();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

// A request needs a span around it. Without one, Sentry still sends `traceparent`, with a parent
// span id that no span has, and the API's spans hang off a parent that never arrives.
// The first screen's load waits for Sentry's screen span; a later one with no span gets its own.
async function api<T>(name: string, path: string, init?: RequestInit): Promise<T> {
  await navigationReady;
  if (Sentry.getActiveSpan()) return request<T>(path, init);
  return Sentry.startSpan({ name, op: "http.request", forceTransaction: true }, () => request<T>(path, init));
}

// A button press: its own trace and its own transaction, so each action is one trace in Sentry
// and in Tempo (otherwise every root span reuses the screen's trace id).
export const action = <T,>(name: string, fn: () => Promise<T>): Promise<T> =>
  startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));

export const getProducts = () => api<Product[]>("load products", "/api/products");

export const checkout = (items: Product[]) =>
  api<{ ok: boolean; orderId: number }>("checkout", "/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: items.map((p) => p.id) }),
  });

export const callBrokenApi = () => api<unknown>("call broken API", "/api/fail");
