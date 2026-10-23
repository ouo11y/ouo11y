// Plain fetch against the demo backend (examples/backend). Sentry's fetch instrumentation turns
// each call into an http.client span and adds sentry-trace / baggage headers.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import { navigationReady, navigationRef } from "./navigation";

export interface Product {
  id: string;
  name: string;
  price: number;
}

export interface Cart {
  items: { productId: string; name: string; qty: number; subtotal: number }[];
  total: number;
}

export interface Flags {
  /** backend `?delay=<ms>` (capped by the backend) */
  delay?: number;
  /** backend `?fail=500` */
  fail?: "500";
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

const USER_ID = "sentry-demo-user";

export function apiUrl(path: string, flags: Flags = {}): string {
  const q: string[] = [];
  if (flags.delay !== undefined) q.push(`delay=${flags.delay}`);
  if (flags.fail) q.push(`fail=${flags.fail}`);
  return `${config.backendUrl}${path}${q.length ? `?${q.join("&")}` : ""}`;
}

type Init = { method?: string; json?: unknown; flags?: Flags };

// A request started while no span is active would carry Sentry's propagation context: a parent
// span id no span has, and an unsampled `traceparent` (flag 00), so the backend drops its spans
// and Tempo shows a broken trace (checklist N24, docs/sentry-client-setup.md section 4).
// - The first screen loads its data on mount, before the navigation container is ready and
//   Sentry's first navigation span exists: wait for it (a few ms) so the request is its child.
//   A root span of our own here would become the SDK's app start transaction.
// - Later requests with no active span (a timer, a screen whose navigation span already ended)
//   get their own transaction.
// Without Sentry.init (the `ouo` rollout mode) startSpan just runs the callback.
async function api<T>(path: string, init: Init = {}): Promise<T> {
  if (!navigationRef.isReady()) await navigationReady;
  if (Sentry.getActiveSpan()) return request<T>(path, init);
  return Sentry.startSpan({ name: `${init.method ?? "GET"} ${path}`, op: "http.request", forceTransaction: true }, () =>
    request<T>(path, init),
  );
}

async function request<T>(path: string, init: Init): Promise<T> {
  const url = apiUrl(path, init.flags);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      "x-user-id": USER_ID,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export const getProducts = (flags?: Flags) => api<Product[]>("/api/products", flags ? { flags } : {});
export const getProduct = (id: string) => api<Product>(`/api/products/${encodeURIComponent(id)}`);
export const getCart = () => api<Cart>("/api/cart");
export const addToCart = (productId: string) => api<Cart>("/api/cart", { method: "POST", json: { productId, qty: 1 } });

export interface Order {
  orderId: string;
  total: number;
  items: number;
}

/** `broken-card` makes the backend answer 500 (payment gateway unavailable). */
export const checkout = (paymentMethod: "card" | "broken-card") => api<Order>("/api/checkout", { method: "POST", json: { paymentMethod } });
export const searchProducts = (delay: number) => api<Product[]>("/api/products", { flags: { delay } });

/**
 * GET through a raw XMLHttpRequest, the transport axios uses in React Native (client-app's API
 * client): proves that XHR clients are traced and propagate like fetch.
 */
export function xhrGet<T>(path: string): Promise<T> {
  const url = apiUrl(path);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("x-user-id", USER_ID);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(JSON.parse(xhr.responseText) as T) : reject(new HttpError(xhr.status, url)));
    xhr.onerror = () => reject(new HttpError(0, url));
    xhr.send();
  });
}

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
