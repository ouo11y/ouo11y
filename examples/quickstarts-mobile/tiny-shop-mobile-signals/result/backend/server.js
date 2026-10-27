// The API. HTTP server spans come from the auto-instrumentation; the spans and the metrics
// below are manual. A native app sends no CORS preflight, so there is no cors() here: the
// `traceparent`, `baggage` and `sentry-trace` headers the app adds are accepted as they are.
const express = require("express");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-signals-backend");
const meter = metrics.getMeter("tiny-shop-mobile-signals-backend");

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
  description: "Checkouts placed, by number of items",
});

const app = express();
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
  // A parent span with two nested children.
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("validate cart", async (child) => {
      await sleep(30);
      child.end();
    });
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      child.addEvent("payment accepted");
      child.end();
    });
    span.end();
  });
  orders.add(1, { "app.cart.items": items.length });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get("/api/fail", (req, res) => {
  // Enrich the auto-created HTTP span with the error.
  const span = trace.getActiveSpan();
  const err = new Error("inventory service unavailable");
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.API_PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-mobile-signals API on http://localhost:${port}`));
