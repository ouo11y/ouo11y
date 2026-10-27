// Calls to the Tiny Shop API. The ouo SDK wraps fetch: every call is an `HTTP <METHOD>` span
// that sends `traceparent` and `baggage` to the API, and a 5xx is an `http.request.failed` event.
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

export const callBrokenApi = () => call<never>("/api/fail");

// One app span around the checkout: the POST below is its child, so the API's spans join the
// same trace. React Native has no async context: after the first `await`, pass the span on.
export function checkout(lines: CartLine[]) {
  return rum.withSpan("place order", async (span) => {
    span.setAttribute("app.cart.items", lines.length);
    rum.log.info(`checkout started with ${lines.length} items`, { "app.cart.items": lines.length });
    const order = await call<{ orderId: number }>("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: lines.map((l) => ({ id: l.id, qty: l.qty })) }),
    });
    const receipt = rum.startSpan("save receipt", { parent: span });
    receipt.setAttribute("app.order.id", order.orderId);
    receipt.end();
    rum.log.info(`order ${order.orderId} placed`, { "app.order.id": order.orderId }, { span });
    return order;
  });
}
