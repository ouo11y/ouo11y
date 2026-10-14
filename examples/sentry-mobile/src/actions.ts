// Every demo action, callable from a button or from a deep link
// (`sentrydemo://action/<name>`, see src/deeplinks.ts). Names are the deep-link path.
import { startNewTrace } from "@sentry/core";
import * as Sentry from "@sentry/react-native";
import { addToCart, type Cart, checkout, getCart, getProduct, getProducts, searchProducts, xhrGet } from "./api";
import { setStatus } from "./status";

export type ActionName =
  | "fetch-ok"
  | "fetch-500"
  | "fetch-slow"
  | "handled-error"
  | "unhandled-rejection"
  | "js-fatal"
  | "native-crash"
  | "message"
  | "browse-catalog"
  | "search"
  | "checkout"
  | "checkout-fail"
  | "xhr-cart"
  | "flush";

// Without startNewTrace every root span reuses the scope's trace id until the next navigation, so
// all flows between two screens would share one trace. Each action is its own trace instead.
const action = <T>(name: string, fn: (span: Sentry.Span) => Promise<T>): Promise<T> =>
  startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));

// Fetch tracing only records an http.client span while a span is active. Outside a navigation
// transaction there is none, so each fetch action runs in its own `ui.action` transaction (what
// user-interaction tracing would create for a tap).
async function fetchAction(label: string, flags?: Parameters<typeof getProducts>[0]): Promise<void> {
  await action(`action ${label}`, async () => {
    try {
      const products = await getProducts(flags);
      Sentry.logger.info(Sentry.logger.fmt`${label}: loaded ${products.length} products`, { "demo.action": label });
      setStatus(`${label}: ${products.length} products`);
    } catch (e) {
      // Not reported to Sentry on purpose: the failed request is visible as an http.client span
      // with status code 500, which is what the bridge turns into http.request.failed.
      Sentry.logger.warn(Sentry.logger.fmt`${label}: request failed: ${(e as Error).message}`, { "demo.action": label });
      setStatus(`${label}: ${(e as Error).message}`);
    }
  });
}

// ---- manually instrumented flows ---------------------------------------------------------------
// Each flow is one `ui.action` transaction with manual child spans (Sentry.startSpan). Every fetch
// inside gets an http.client span and `traceparent`, so the backend's OpenTelemetry spans join the
// same trace: in Tempo one trace holds the app spans and the backend spans.

const step = <T>(name: string, op: string, fn: () => Promise<T> | T): Promise<T> =>
  Sentry.startSpan({ name, op }, async () => fn());

/** Busy work so a span has a visible duration without the network. */
function crunch(ms: number): number {
  const until = Date.now() + ms;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  return n;
}

async function browseCatalog(): Promise<void> {
  await action("browse catalog", async (span) => {
    const products = await step("load catalog", "function", () => getProducts());
    // Details of the first four products in parallel: four sibling http.client spans.
    const details = await step("load product details", "function", () => Promise.all(products.slice(0, 4).map((p) => getProduct(p.id))));
    await step("rank products", "function", () => crunch(40));
    span.setAttribute("catalog.size", products.length);
    Sentry.logger.info(Sentry.logger.fmt`catalog loaded: ${products.length} products, ${details.length} details`, {
      "catalog.size": products.length,
      "catalog.details": details.length,
    });
    setStatus(`browse-catalog: ${products.length} products, ${details.length} details`);
  });
}

async function search(): Promise<void> {
  await action("search products", async () => {
    const query = ["trail", "tent", "lamp", "poles"][Math.floor(Math.random() * 4)] ?? "tent";
    Sentry.logger.debug(Sentry.logger.fmt`search started for ${query}`, { "search.query": query });
    // The backend sleeps 600 ms in a db.query span: a slow search worth seeing in the trace.
    const all = await step("query backend", "function", () => searchProducts(600));
    const hits = await step("filter results", "function", () => {
      crunch(25);
      return all.filter((p) => p.name.toLowerCase().includes(query));
    });
    Sentry.logger.info(Sentry.logger.fmt`search for ${query}: ${hits.length} hits`, { "search.query": query, "search.hits": hits.length });
    setStatus(`search ${query}: ${hits.length} hits`);
  });
}

async function checkoutFlow(paymentMethod: "card" | "broken-card"): Promise<void> {
  const label = paymentMethod === "card" ? "checkout" : "checkout-fail";
  await action(label, async (span) => {
    span.setAttribute("payment.method", paymentMethod);
    const products = await step("pick products", "function", () => getProducts());
    const picks = products.slice(0, 2);
    for (const p of picks) {
      await step(`add ${p.id} to cart`, "function", () => addToCart(p.id));
    }
    const cart = await step("review cart", "function", () => getCart());
    Sentry.logger.info(Sentry.logger.fmt`checkout started with ${cart.items.length} lines`, {
      "cart.lines": cart.items.length,
      "cart.total": cart.total,
      "payment.method": paymentMethod,
    });
    try {
      const order = await step("submit order", "function", () => checkout(paymentMethod));
      Sentry.logger.info(Sentry.logger.fmt`order ${order.orderId} placed`, { "order.id": order.orderId, "order.total": order.total });
      setStatus(`${label}: order ${order.orderId}`);
    } catch (e) {
      span.setStatus({ code: 2, message: "internal_error" });
      Sentry.logger.error(Sentry.logger.fmt`payment failed: ${(e as Error).message}`, { "payment.method": paymentMethod });
      setStatus(`${label}: ${(e as Error).message}`);
    }
  });
}

export const actions: Record<ActionName, { title: string; run: () => void | Promise<void> }> = {
  "fetch-ok": { title: "Fetch products", run: () => fetchAction("fetch-ok") },
  "fetch-500": { title: "Fetch 500", run: () => fetchAction("fetch-500", { fail: "500" }) },
  "fetch-slow": { title: "Slow fetch (2.5 s)", run: () => fetchAction("fetch-slow", { delay: 2500 }) },
  "handled-error": {
    title: "Handled error",
    run: () => {
      try {
        throw new Error("sentry-demo handled error: coupon service unavailable");
      } catch (e) {
        const id = Sentry.captureException(e, { tags: { "demo.action": "handled-error" } });
        setStatus(`handled-error: event ${id.slice(0, 8)}`);
      }
    },
  },
  "unhandled-rejection": {
    title: "Unhandled rejection",
    run: () => {
      // Non-fatal: RN's promise rejection tracking hands it to Sentry, the app keeps running.
      void Promise.reject(new Error("sentry-demo unhandled promise rejection"));
      setStatus("unhandled-rejection: rejected a promise");
    },
  },
  "js-fatal": {
    title: "JS fatal (setTimeout throw)",
    run: () => {
      // Fatal in a Release build: RN's global handler gets isFatal = true, Sentry records a
      // `fatal` event and RN then terminates the app (RCTFatal). Not part of the default journey.
      setStatus("js-fatal: throwing from setTimeout");
      setTimeout(() => {
        throw new Error("sentry-demo fatal JS error from setTimeout");
      }, 50);
    },
  },
  "native-crash": {
    title: "Native crash",
    run: () => {
      setStatus("native-crash: crashing");
      // Give the status line one frame so it is in the replay, then crash in sentry-cocoa.
      setTimeout(() => Sentry.nativeCrash(), 300);
    },
  },
  message: {
    title: "Breadcrumb + message",
    run: () => {
      Sentry.addBreadcrumb({ category: "demo", message: "user opened the promo sheet", level: "info", data: { promo: "AUTUMN" } });
      const id = Sentry.captureMessage("sentry-demo custom message: promo sheet opened", "info");
      setStatus(`message: event ${id.slice(0, 8)}`);
    },
  },
  "browse-catalog": { title: "Browse catalog (5 requests)", run: browseCatalog },
  search: { title: "Search (slow backend)", run: search },
  checkout: { title: "Checkout", run: () => checkoutFlow("card") },
  "checkout-fail": { title: "Checkout, card declined (500)", run: () => checkoutFlow("broken-card") },
  "xhr-cart": {
    title: "Cart via XMLHttpRequest (axios path)",
    run: () =>
      action("xhr cart", async () => {
        const cart = await xhrGet<Cart>("/api/cart");
        Sentry.logger.info(Sentry.logger.fmt`xhr cart: ${cart.items.length} lines`, { "cart.lines": cart.items.length });
        setStatus(`xhr-cart: ${cart.items.length} lines`);
      }),
  },
  flush: {
    title: "Flush",
    run: async () => {
      const ok = await Sentry.flush();
      setStatus(`flush: ${ok ? "done" : "timed out"}`);
    },
  },
};

export function runAction(name: string): boolean {
  const action = (actions as Record<string, (typeof actions)[ActionName]>)[name];
  if (!action) {
    setStatus(`unknown action ${name}`);
    return false;
  }
  Sentry.addBreadcrumb({ category: "demo.action", message: name, level: "info" });
  void Promise.resolve(action.run()).catch((e) => setStatus(`${name} failed: ${String(e)}`));
  return true;
}
