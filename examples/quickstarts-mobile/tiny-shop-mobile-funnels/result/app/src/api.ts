// Calls to the Tiny Shop API. The ouo SDK wraps fetch: every call is an `HTTP <METHOD>` span
// that sends `traceparent` and `baggage` to the API.
import { apiUrl, rum } from "./rum";

export type Product = { id: number; name: string; price: number };
export type CartLine = Product & { qty: number };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${body.error ?? res.statusText}`);
  return body as T;
}

export const getProducts = () => call<Product[]>("/api/products");

// The last funnel step: `order_paid`, only once the API answered with an order.
export async function checkout(lines: CartLine[]) {
  const order = await call<{ orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: lines.map((l) => ({ id: l.id, qty: l.qty })) }),
  });
  rum.addEvent("order_paid", { "app.order.id": order.orderId, "app.cart.items": lines.length });
  return order;
}
