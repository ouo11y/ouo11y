// Plain fetch against the demo backend (examples/backend). Sentry's fetch instrumentation turns
// each call into an http.client span and adds sentry-trace / baggage headers.
import { config } from "./config";

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

async function api<T>(path: string, init: { method?: string; json?: unknown; flags?: Flags } = {}): Promise<T> {
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
