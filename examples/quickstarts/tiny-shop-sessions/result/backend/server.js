// The API: products, a checkout, and an endpoint that always fails for the "break it" panel.
// HTTP server spans come from the auto-instrumentation; the checkout span is manual.
const express = require("express");
const cors = require("cors");
const { trace } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-sessions-backend");

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage` headers
// (the baggage carries session.id and user.id); cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  await sleep(40);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  const orderId = await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await sleep(120);
    span.end();
    return Math.floor(Math.random() * 100000);
  });
  res.json({ ok: true, orderId });
});

// "Break it" -> "Failed request": always 500. The browser records `http.request.failed`, which
// marks the session errored.
app.get("/api/broken", (req, res) => {
  res.status(500).json({ error: "this endpoint always fails" });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-sessions API on http://localhost:${port}`));
