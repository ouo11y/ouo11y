/**
 * One "app launch" of the mobile-store scenario, driven by SCENARIO:
 *   healthy  : products, add to cart, checkout (card)
 *   errored  : products, handled error, 500
 *   crash    : products, then a fatal error through ErrorUtils (writes the crash marker)
 *   relaunch : nothing but init (processes the crash marker -> session.end crash)
 *   background: long background stay -> session rotation
 * Env: OUO_OTLP (default http://localhost:4328), OUO_BACKEND (default http://localhost:8082),
 *      APP_VERSION (default 2.3.0), OUO_STORAGE_FILE (shared "disk").
 */
const { initRUM } = require("../dist/index.js");

const OTLP = process.env.OUO_OTLP || "http://localhost:4328";
const BACKEND = process.env.OUO_BACKEND || "http://localhost:8082";
const VERSION = process.env.APP_VERSION || "2.3.0";
const SCENARIO = process.env.SCENARIO || "healthy";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rum = initRUM({
    endpoint: OTLP,
    service: { name: "mobile-store", version: VERSION, environment: "local" },
    tracing: { propagateTo: [new RegExp(`^${BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)] },
    session: { backgroundTimeoutMs: 2000 },
    device: { modelIdentifier: "iPhone15,2", modelName: "iPhone 14 Pro", manufacturer: "Apple" },
    debug: process.env.OUO_DEBUG === "1",
  });
  await rum.ready;
  const id = rum.session.id();
  console.log(`scenario=${SCENARIO} version=${VERSION} session=${id} previous=${rum.session.previousId() ?? "-"} user=${rum.session.userId()}`);
  const headers = { "x-user-id": rum.session.userId(), accept: "application/json" };
  const get = (p) => fetch(`${BACKEND}${p}`, { headers });
  const post = (p, body) => fetch(`${BACKEND}${p}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  rum.trackNavigation("/Products");
  switch (SCENARIO) {
    case "healthy": {
      const products = await (await get("/api/products")).json();
      rum.trackNavigation("/Product");
      await post("/api/cart", { productId: products[0].id, qty: 1 });
      rum.addEvent("cart.added", { "product.id": products[0].id });
      rum.trackNavigation("/Checkout");
      const order = await (await post("/api/checkout", { paymentMethod: "card" })).json();
      console.log("order", order.orderId, "total", order.total);
      break;
    }
    case "errored": {
      await get("/api/products");
      rum.trackNavigation("/Chaos");
      rum.captureError(new Error("Handled error from the Chaos screen"), { screen: "Chaos" });
      const res = await get("/api/products?fail=500");
      console.log("500 request ->", res.status);
      break;
    }
    case "crash": {
      await get("/api/products");
      rum.trackNavigation("/Chaos");
      await new Promise((resolve) => {
        // The SDK handler runs first (exception event, crash marker, flush) and then calls the
        // previous handler, which is the preload's default one; it resolves this promise.
        globalThis.__onDefaultErrorHandler = () => resolve();
        setTimeout(() => {
          try {
            throw new TypeError("Fatal error from the Chaos screen (setTimeout)");
          } catch (err) {
            // Node has no RN timer guard; invoke the global handler like ErrorUtils.reportFatalError.
            globalThis.ErrorUtils.getGlobalHandler()(err, true);
          }
        }, 10);
      });
      console.log("fatal handled; exiting without a clean session.end (like a native crash)");
      process.exit(0);
    }
    case "background": {
      await get("/api/products");
      require("react-native").AppState.__emit("background");
      await sleep(2500);
      require("react-native").AppState.__emit("active");
      console.log("after background: session", rum.session.id(), "previous", rum.session.previousId());
      await get("/api/cart");
      break;
    }
    case "relaunch":
      break;
    default:
      throw new Error(`unknown scenario ${SCENARIO}`);
  }
  await rum.flush();
  await sleep(300);
  console.log("flushed");
  // The session timers keep a Node process alive (an app never exits this way).
  process.exit(0);
}

main().catch((err) => {
  console.error("scenario failed", err);
  process.exit(1);
});
