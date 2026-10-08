// Fetch wrapper for the demo backend. traceparent / baggage headers are added by the
// SDK's fetch wrapper; only x-user-id (the backend's cart key) is set here.
import { config, rum } from "./rum";

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

export interface Order {
  orderId: string;
  total: number;
  items: number;
}

export interface FaultFlags {
  delay?: number;
  fail?: "500" | "timeout";
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, url: string, message: string) {
    super(`${message} (${status} ${url})`);
    this.name = "ApiError";
    this.status = status;
  }
}

export function apiUrl(path: string, flags: FaultFlags = {}): string {
  const params: string[] = [];
  if (flags.delay !== undefined) params.push(`delay=${flags.delay}`);
  if (flags.fail !== undefined) params.push(`fail=${flags.fail}`);
  return `${config.backendUrl}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

async function api<T>(path: string, init: { method?: string; json?: unknown; flags?: FaultFlags } = {}): Promise<T> {
  const url = apiUrl(path, init.flags);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      "x-user-id": rum.session.userId(),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  if (!res.ok) {
    let message = res.statusText || "request failed";
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // body not JSON
    }
    throw new ApiError(res.status, url, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getProducts = (flags?: FaultFlags) => api<Product[]>("/api/products", flags ? { flags } : {});
export const getProduct = (id: string) => api<Product>(`/api/products/${encodeURIComponent(id)}`);
export const getCart = () => api<Cart>("/api/cart");
export const addToCart = (productId: string, qty: number) => api<Cart>("/api/cart", { method: "POST", json: { productId, qty } });
export const checkout = (paymentMethod: PaymentMethod) => api<Order>("/api/checkout", { method: "POST", json: { paymentMethod } });

export const formatPrice = (n: number): string => `$${n.toFixed(2)}`;
