// Fetch wrapper for the demo backend. traceparent / baggage headers are added
// by the SDK's fetch instrumentation; only x-user-id is set here.
import { config, storedUserId } from "./rum";

export interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
}

export interface CartItem {
  productId: string;
  name: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
}

export interface Cart {
  userId: string;
  items: CartItem[];
  itemCount: number;
  total: number;
}

export type PaymentMethod = "card" | "broken-card";

// The backend rejects unknown JSON fields, so only paymentMethod is sent.
// Name, email and card number stay in the browser (they exist to exercise
// replay input masking).
export interface CheckoutRequest {
  paymentMethod: PaymentMethod;
}

export interface Order {
  orderId: string;
  total: number;
  items: number; // item count, not the lines
}

export interface FaultFlags {
  delay?: number;
  fail?: "500" | "timeout";
}

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, message: string) {
    super(`${message} (${status} ${url})`);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
  }
}

export function apiUrl(path: string, flags: FaultFlags = {}): string {
  const url = new URL(path, config.backendUrl);
  if (flags.delay !== undefined) url.searchParams.set("delay", String(flags.delay));
  if (flags.fail !== undefined) url.searchParams.set("fail", flags.fail);
  return url.toString();
}

export async function api<T>(
  path: string,
  init: RequestInit & { flags?: FaultFlags; json?: unknown } = {},
): Promise<T> {
  const { flags, json, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  headers.set("accept", "application/json");
  const user = storedUserId();
  if (user) headers.set("x-user-id", user);
  if (json !== undefined) headers.set("content-type", "application/json");

  const res = await fetch(apiUrl(path, flags), {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body ?? null,
  });
  if (!res.ok) {
    let message = res.statusText || "request failed";
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // body not JSON
    }
    throw new ApiError(res.status, res.url, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getProducts = (flags?: FaultFlags, signal?: AbortSignal) =>
  api<Product[]>("/api/products", { ...(flags ? { flags } : {}), ...(signal ? { signal } : {}) });

export const getProduct = (id: string) => api<Product>(`/api/products/${encodeURIComponent(id)}`);

export const getCart = () => api<Cart>("/api/cart");

export const addToCart = (productId: string, qty: number) =>
  api<Cart>("/api/cart", { method: "POST", json: { productId, qty } });

export const checkout = (body: CheckoutRequest, flags?: FaultFlags) =>
  api<Order>("/api/checkout", { method: "POST", json: body, ...(flags ? { flags } : {}) });

export const formatPrice = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
