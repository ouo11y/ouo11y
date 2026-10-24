// The API. HTTP server spans come from the auto-instrumentation; the spans and the metrics
// below are manual.
const express = require("express");
const cors = require("cors");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-signals-backend");
const meter = metrics.getMeter("tiny-shop-signals-backend");

// Three metrics, named like OpenTelemetry semantic conventions. Mimir turns dots into
// underscores: shop_http_requests, shop_http_request_duration_bucket, shop_orders.
const requests = meter.createCounter("shop.http.requests", {
  description: "API requests, by route and status code",
});
const duration = meter.createHistogram("shop.http.request.duration", {
  description: "API request duration",
  unit: "ms",
  advice: { explicitBucketBoundaries: [10, 25, 50, 100, 200, 400, 800] },
});
const orders = meter.createCounter("shop.orders", {
  description: "Checkouts, by result (placed or failed) and number of items",
});

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage`
// headers; cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

// Count and time every request once the response is sent.
app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const attrs = { "http.route": req.route?.path ?? "unknown", "http.response.status_code": res.statusCode };
    requests.add(1, attrs);
    duration.record(performance.now() - start, attrs);
  });
  next();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  // A manual span around a "database" call.
  const result = await tracer.startActiveSpan("db.select products", async (span) => {
    span.setAttribute("db.system.name", "fake-db");
    await sleep(50 + Math.random() * 100);
    span.setAttribute("app.products.count", products.length);
    span.end();
    return products;
  });
  res.json(result);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  // The deliberately failing path: one checkout in three fails at the payment step and
  // answers 500. The browser records `http.request.failed`, so that session is `errored`.
  const declined = Math.random() < 1 / 3;
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("validate cart", async (child) => {
      await sleep(30);
      child.end();
    });
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      if (declined) {
        const err = new Error("payment provider timeout");
        child.recordException(err);
        child.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      } else {
        child.addEvent("payment accepted");
      }
      child.end();
    });
    span.end();
  });
  orders.add(1, { "app.order.result": declined ? "failed" : "placed", "app.cart.items": items.length });
  if (declined) return res.status(500).json({ error: "payment provider timeout" });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-signals API on http://localhost:${port}`));
