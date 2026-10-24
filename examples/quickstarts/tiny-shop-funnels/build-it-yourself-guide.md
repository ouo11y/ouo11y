# Build Tiny Shop Funnels yourself

Quickstart 4 ([tiny-shop-replay](https://github.com/ouo11y/ouo11y/tree/main/examples/quickstarts/tiny-shop-replay), PR #68) records what one shopper did.
This guide turns the same shop into a funnel: which share of shoppers goes from the home page to
a paid order, where the rest stop, and the replay of those who stopped. You start from
quickstart 4's finished app and change only what is new. Every changed file is below in a
collapsible section: open it, copy it, paste it over the file named in its title. Each step ends
with something you can see. About 20 minutes; needs Node 24, Docker Compose 2.24 or later and a
clone of [ouo11y/ouo11y](https://github.com/ouo11y/ouo11y) (step 2 explains why).

```
tiny-shop-funnels/
├── stack/              the ouo stack; rum-api and Grafana now built from the clone
├── backend/            Express API, unchanged but for the order total
├── frontend/           React shop with five pages and three custom events
└── generate-sessions/  new: 50 shoppers in headless Chromium
```

## 1. Start from quickstart 4

Copy quickstart 4's result (your own folder if you built it, or `result/` of
`examples/quickstarts/tiny-shop-replay` in the clone) and rename it everywhere, so its data stays
apart from quickstart 4's:

```bash
cp -R tiny-shop-replay tiny-shop-funnels && cd tiny-shop-funnels
rm -rf frontend/node_modules backend/node_modules
grep -rliE 'tiny-shop-replay|tiny shop replay' --exclude=package-lock.json . \
  | xargs sed -i.bak -e 's/tiny-shop-replay/tiny-shop-funnels/g' -e 's/Tiny Shop Replay/Tiny Shop Funnels/g'
find . -name '*.bak' -delete
```

Check: `grep -riE 'tiny-shop-replay|tiny shop replay' --exclude=package-lock.json .` prints nothing.

## 2. The stack: rum-api and Grafana with funnels

Funnels live in rum-api (`POST /v1/funnels/query`) and in the Grafana plugin (the **Funnels**
page). The released images (`0.3.0`) do not have them yet, so these two services are built from
the clone; everything else in `stack/` stays as it is. When a release with funnels is out, put
back `image: ghcr.io/ouo11y/rum-api:<version>` and `image: ghcr.io/ouo11y/grafana:<version>` and
skip the build.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/stack/50-rum-api/compose.yaml -->
```yaml
# rum-api: the ouo platform service behind the Grafana plugin. It builds the session list
# (healthy / errored / crashed) and the funnel reports from Loki and Tempo, and stores replay
# chunks the collector forwards. Internal: only the collector and Grafana talk to it, on 8080
# inside the network.
#
# Built from source: funnels (POST /v1/funnels/query) are newer than the released
# ghcr.io/ouo11y/rum-api:0.3.0. Once a rum-api release with funnels is tagged, replace `build:`
# with `image: ghcr.io/ouo11y/rum-api:<that version>` (see the README, "Released images").
services:
  rum-api:
    build:
      # services/rum-api of an ouo11y checkout. OUO11Y_REPO: the checkout's root (default: this
      # folder's place inside the repository).
      context: ${OUO11Y_REPO:-../../../../../..}/services/rum-api
      args: { VERSION: funnels-from-source }
    image: tiny-shop-funnels/rum-api:from-source
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}   # for deep links
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # the collector's; development value
      OUO_READ_TOKEN: rt_dev_0000000000000000     # Grafana's; development value
      DATA_DIR: /home/nonroot                     # the image runs as nonroot
    volumes:
      - ./config.yaml:/etc/rum-api/config.yaml:ro
      - rum-api-data:/home/nonroot
    depends_on: [loki, tempo]

volumes:
  rum-api-data:
```

</details>
<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo and Loki
# directly, and sessions, funnels and replays from rum-api through the plugin. Port 3000,
# admin / testing567. provisioning/ sets up the datasources and the plugin.
#
# Built from source: the plugin's Funnels page is newer than the released
# ghcr.io/ouo11y/grafana:0.3.0. Dockerfile builds plugins/ouo11y-rum-app of this repository and
# copies it into grafana/grafana, like the released image. Once a grafana image with funnels is
# tagged, replace `build:` with `image: ghcr.io/ouo11y/grafana:<that version>`.
services:
  grafana:
    build:
      context: ${OUO11Y_REPO:-../../../../../..}   # an ouo11y checkout's root (the plugin is a workspace)
      dockerfile: examples/quickstarts/tiny-shop-funnels/result/stack/60-grafana/Dockerfile
    image: tiny-shop-funnels/grafana:from-source
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: testing567
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: ouo11y-rum-app
      GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS: ouo11y-rum-app
      OUO_READ_TOKEN: rt_dev_0000000000000000   # read by provisioning/plugins; equals rum-api's
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
    depends_on: [loki, tempo, rum-api]
```

</details>

The Grafana build uses the Dockerfile kept in the clone (it builds the plugin with npm, then
copies it into `grafana/grafana`, like the released image). Nothing to copy; for reference:

<details>
<summary><code>stack/60-grafana/Dockerfile</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/stack/60-grafana/Dockerfile -->
```dockerfile
# syntax=docker/dockerfile:1
# Grafana with the ouo11y RUM app plugin built from this repository (the Funnels page is not in
# a released image yet). Build context: the repository root (60-grafana/compose.yaml sets it).
# Same result as deploy/images/grafana/Dockerfile, plus the plugin build.
FROM node:24-bookworm-slim AS plugin
WORKDIR /src
# The plugin is an npm workspace of the repository: install from the root lockfile, plugin only.
COPY package.json package-lock.json ./
COPY sdk/browser/package.json sdk/browser/
COPY sdk/react-native/package.json sdk/react-native/
COPY examples/ouo-web/package.json examples/ouo-web/
COPY plugins/ouo11y-rum-app/package.json plugins/ouo11y-rum-app/
RUN npm ci --no-audit --no-fund --ignore-scripts -w plugins/ouo11y-rum-app
COPY plugins/ouo11y-rum-app plugins/ouo11y-rum-app
RUN npm run build -w plugins/ouo11y-rum-app

FROM grafana/grafana:13.2.1
COPY --from=plugin --chown=grafana:root /src/plugins/ouo11y-rum-app/dist /var/lib/grafana/plugins/ouo11y-rum-app
ENV GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app \
    GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo11y-rum-app
```

</details>

Point the build at your clone and start the stack. The collector image is private for now, so
log in to ghcr.io once if you have not (quickstart 4's README shows how). From `stack`, the first
build takes two to three minutes:

```bash
export OUO11Y_REPO=/path/to/ouo11y
docker compose up -d --build
```

Check: rum-api knows the new endpoint (a 400 for an empty funnel, not a 404):

```bash
docker compose exec grafana curl -s -X POST http://rum-api:8080/v1/funnels/query \
  -H 'Authorization: Bearer rt_dev_0000000000000000' -d '{"steps":[]}'
```

It prints `{"error":"a funnel has 2 to 10 steps"}`. In Grafana (http://localhost:3000,
admin / testing567), More apps -> ouo11y RUM now has **Funnels**.

## 3. The shop: pages and custom events

A funnel step is a **page path** or a **custom event name**:

- **Pages** come for free: `@ouo11y/browser` records every page load and every
  `history.pushState` / `replaceState` / back-forward as a `navigation` event with `url.path`.
  Quickstart 4's shop was one page, so the new `App.jsx` gets five, switched with `pushState`:
  `/`, `/products/<id>`, `/cart`, `/checkout`, `/orders/<id>`.
- **Events** are what you call: `rum.addEvent("add_to_cart", {...})` when a product goes in the
  cart, `checkout_submitted` on Pay, `order_paid` when the API accepts the payment.

The coupon and order-tracker buttons, the blocked banner and the masked shipping line of
quickstart 4 are gone: this shop is about the path to the order.

<details>
<summary><code>frontend/src/App.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/frontend/src/App.jsx -->
```jsx
import { useEffect, useState } from "react";
import { API, rum } from "./rum";

// A five-page shop. Every page change goes through history.pushState, which the SDK records as a
// `navigation` event with `url.path`: those are the funnel's page steps. The custom events
// (rum.addEvent) are its event steps:
//
//   /  ->  /products/<id>  ->  add_to_cart  ->  /checkout  ->  order_paid
//
// Funnel step = a page path (exact, or prefix such as /products/*) or a custom event name.

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (to) => {
    history.pushState(null, "", to); // recorded by the SDK as navigation (kind push)
    setPath(to);
  };
  return [path, go];
}

function Link({ to, go, children, ...rest }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export default function App() {
  const [path, go] = usePath();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  function addToCart(p) {
    setCart([...cart, p]);
    // A custom event: a funnel step by its name. Attributes are kept on the event (Loki
    // structured metadata) and shown on the session timeline.
    rum.addEvent("add_to_cart", { "product.id": p.id, "product.name": p.name });
  }

  async function pay(e) {
    e.preventDefault();
    const card = new FormData(e.target).get("card") || "";
    rum.addEvent("checkout_submitted", { "cart.items": cart.length });
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id), cardLast4: card.slice(-4) }),
    });
    if (!res.ok) {
      rum.captureError(new Error(`checkout failed: ${(await res.json()).error}`));
      setMessage("Payment failed, try another card");
      return;
    }
    const data = await res.json();
    rum.addEvent("order_paid", { "order.id": data.orderId, "order.total": data.total });
    setCart([]);
    go(`/orders/${data.orderId}`);
  }

  const product = path.startsWith("/products/") && products.find((p) => `/products/${p.id}` === path);

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 520, margin: "40px auto" }}>
      <nav style={{ display: "flex", gap: 12 }}>
        <Link to="/" go={go}>Tiny Shop</Link>
        <Link to="/cart" go={go} data-testid="cart-link">Cart ({cart.length})</Link>
      </nav>

      {path === "/" && (
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              <Link to={`/products/${p.id}`} go={go}>{p.name}</Link> (${p.price})
            </li>
          ))}
        </ul>
      )}

      {product && (
        <section>
          <h2>{product.name}</h2>
          <p>{product.blurb}</p>
          <button onClick={() => addToCart(product)}>Add to cart (${product.price})</button>
        </section>
      )}

      {path === "/cart" && (
        <section>
          <h2>Cart</h2>
          <ul>
            {cart.map((p, i) => (
              <li key={i}>{p.name}</li>
            ))}
          </ul>
          <button disabled={!cart.length} onClick={() => go("/checkout")}>Go to checkout</button>
        </section>
      )}

      {path === "/checkout" && (
        <form onSubmit={pay} style={{ display: "grid", gap: 6 }}>
          <h2>Checkout</h2>
          <input name="card" placeholder="card number" autoComplete="cc-number" />
          <button disabled={!cart.length}>Pay</button>
        </form>
      )}

      {path.startsWith("/orders/") && <h2>Thanks! Order {path.split("/").pop()} is paid.</h2>}

      <p>{message}</p>
    </main>
  );
}
```

</details>

In `rum.js` only the end changes: no session sampling (a funnel counts sessions), replay for
every session (to watch the ones that drop), the click signals and debug logging off.

<details>
<summary><code>frontend/src/rum.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/frontend/src/rum.js -->
```js
// ouo browser SDK init: sessions, page views and custom events (the funnel steps), errors, fetch
// tracing and session replay, so a session that dropped out of the funnel can be watched.
import { initRUM } from "@ouo11y/browser";

// The API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector, the only thing the page talks to. Spans and events go to 4318, replay
  // chunks to 4319 (derived from `endpoint` when it uses port 4318). Moved ports? Set
  // VITE_OUO_ENDPOINT and VITE_OUO_REPLAY_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-funnels-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace and the
  // replay, the click and the backend error share one trace id.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },

  // Every session is kept: a funnel counts sessions, so sampling would scale every step down.
  session: { sampleRate: 1 },
  // Replay of every session, inputs masked: open a dropped session from the funnel and watch it.
  replay: { enabled: true, sampleRate: 1, maskAllInputs: true },
  debug: false,
});
```

</details>

The API sends the order total back, for the `order_paid` event. Product blurbs are new; the
`/api/orders/track` route is gone; the checkout still declines card `...0002`.

<details>
<summary><code>backend/server.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const cors = require("cors");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-funnels-backend");

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage`
// headers; cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4, blurb: "Single origin, roasted on Tuesdays." },
  { id: 2, name: "Tea", price: 3, blurb: "Loose leaf green tea." },
  { id: 3, name: "Cake", price: 6, blurb: "Lemon drizzle, one slice." },
];

app.get("/api/products", async (req, res) => {
  await sleep(50 + Math.random() * 100);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  // The failing path, on demand: a card ending in 0002 is declined (a common test card), so you
  // know which checkout to look for in the replay. Any other card succeeds.
  const declined = String(req.body.cardLast4 || "") === "0002";
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      if (declined) {
        const err = new Error("card declined by payment provider");
        child.recordException(err);
        child.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
      child.end();
    });
    if (declined) span.setStatus({ code: SpanStatusCode.ERROR, message: "card declined" });
    span.end();
  });
  if (declined) return res.status(500).json({ error: "card declined" });
  const total = items.reduce((sum, id) => sum + (products.find((p) => p.id === id)?.price || 0), 0);
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000), total });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-funnels API on http://localhost:${port}`));
```

</details>

Start both, each in its own terminal. From `backend`:

```bash
npm install && npm start
```

From `frontend`:

```bash
npm install && npm run dev
```

Check: open http://localhost:5173, click **Coffee**, **Add to cart**, **Cart (1)**, **Go to
checkout**, type card `4242424242424242`, **Pay**. You land on "Thanks! Order ... is paid". In
Grafana -> ouo11y RUM -> **Sessions**, open your session: the activity list has `navigation`
entries for `/`, `/products/1`, `/cart`, `/checkout`, `/orders/...`, and `add_to_cart`,
`checkout_submitted`, `order_paid` between them.

## 4. Fifty shoppers

One session makes a dull funnel. `generate-sessions` drives 50 headless Chromium sessions
through the shop, each one a real browser running the real SDK, so page views, events and
replays reach ouo exactly as from people. Each session follows one persona (bounce, deep link,
out of order, browse, cart, abandon, declined card, buyer) with random pauses; the seed makes
the mix the same on every run, and the script ends with how many sessions should reach each step.

```bash
mkdir generate-sessions && cd generate-sessions
```

<details>
<summary><code>generate-sessions/package.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/generate-sessions/package.json -->
```json
{
  "name": "tiny-shop-funnels-generate-sessions",
  "private": true,
  "version": "1.0.0",
  "description": "ouo quickstart: drives ~50 real browser sessions through the shop so the funnel has shape",
  "type": "module",
  "scripts": {
    "generate": "node generate.mjs"
  },
  "engines": {
    "node": ">=24"
  },
  "devDependencies": {
    "playwright": "1.64.1"
  }
}
```

</details>
<details>
<summary><code>generate-sessions/generate.mjs</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-funnels/result/generate-sessions/generate.mjs -->
```js
// Drives ~50 sessions through the running shop in headless Chromium, each one a real browser with
// the real SDK, so page views, custom events and replays reach ouo exactly as from people.
// Each session follows one persona; the script prints how many sessions should reach each funnel
// step, so you can check the funnel in Grafana against it.
//
//   npm install && npx playwright install chromium   # once
//   npm run generate                                 # SHOP_URL=http://localhost:5173 by default
import { chromium } from "playwright";

const SHOP = process.env.SHOP_URL || "http://localhost:5173";
const SESSIONS = Number(process.env.SESSIONS || 50);
const PARALLEL = Number(process.env.PARALLEL || 5);

// The funnel the README builds: / -> /products/* -> add_to_cart -> /checkout -> order_paid.
const STEPS = ["page:/", "page:/products/*", "event:add_to_cart", "page:/checkout", "event:order_paid"];

// Persona: weight (share of sessions), the funnel step it reaches (0: never enters) and what it does.
const PERSONAS = {
  bounce: { weight: 10, reaches: 1, run: async (s) => { await s.open("/"); } },
  // Lands on a product from a link, never sees the home page: not in the funnel (step 1 is /).
  deepLink: { weight: 10, reaches: 0, run: async (s) => { await s.open("/products/2"); await s.add(); await s.checkout(); await s.pay("4242"); } },
  // Adds to cart first and visits / afterwards: the order matters, so it only reaches step 1.
  outOfOrder: { weight: 6, reaches: 1, run: async (s) => { await s.open("/products/1"); await s.add(); await s.home(); } },
  browse: { weight: 18, reaches: 2, run: async (s) => { await s.open("/"); await s.product(); if (s.coin()) { await s.home(); await s.product(); } } },
  cart: { weight: 16, reaches: 3, run: async (s) => { await s.open("/"); await s.product(); await s.add(); if (s.coin()) await s.add(); } },
  abandon: { weight: 12, reaches: 4, run: async (s) => { await s.open("/"); await s.product(); await s.add(); await s.checkout(); } },
  declined: { weight: 8, reaches: 4, run: async (s) => { await s.open("/"); await s.product(); await s.add(); await s.checkout(); await s.pay("0002"); } },
  buyer: { weight: 20, reaches: 5, run: async (s) => { await s.open("/"); await s.product(); if (s.coin()) { await s.home(); await s.product(); } await s.add(); await s.checkout(); await s.pay("4242"); } },
};

// Deterministic: the same seed gives the same personas and pauses (Mulberry32).
let seed = Number(process.env.SEED || 7);
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pickPersonas(n) {
  // Largest remainder: the counts follow the weights exactly, then the order is shuffled.
  const names = Object.keys(PERSONAS);
  const total = names.reduce((s, k) => s + PERSONAS[k].weight, 0);
  const exact = names.map((k) => (PERSONAS[k].weight * n) / total);
  const counts = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - counts[i], i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; counts.reduce((a, b) => a + b, 0) < n; i++) counts[order[i][1]]++;
  const list = names.flatMap((k, i) => Array(counts[i]).fill(k));
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const pause = (page, min, max) => page.waitForTimeout(min + rand() * (max - min));

function session(page) {
  const s = {
    coin: () => rand() < 0.5,
    open: async (path) => {
      await page.goto(SHOP + path);
      await page.waitForLoadState("networkidle");
      await pause(page, 300, 1500);
    },
    home: async () => {
      await page.getByRole("link", { name: "Tiny Shop" }).click();
      await pause(page, 300, 1200);
    },
    product: async () => {
      const links = page.locator("ul li a");
      await links.first().waitFor();
      await links.nth(Math.floor(rand() * (await links.count()))).click();
      await pause(page, 800, 4000); // reading the product page
    },
    add: async () => {
      await page.getByRole("button", { name: /Add to cart/ }).click();
      await pause(page, 300, 1500);
    },
    checkout: async () => {
      await page.getByTestId("cart-link").click();
      await pause(page, 300, 1200);
      await page.getByRole("button", { name: "Go to checkout" }).click();
      await pause(page, 1000, 5000); // finding the card
    },
    pay: async (card) => {
      await page.getByPlaceholder("card number").fill(`4000 0000 0000 ${card}`);
      await page.getByRole("button", { name: "Pay" }).click();
      await page.waitForLoadState("networkidle");
      await pause(page, 500, 1500);
    },
  };
  return s;
}

async function runOne(browser, persona, i) {
  const context = await browser.newContext(); // fresh storage: a new user and a new session
  const page = await context.newPage();
  try {
    await PERSONAS[persona].run(session(page));
    // Leaving the page flushes the SDK's last batch (pagehide) and ends the session.
    await page.goto("about:blank");
    await page.waitForTimeout(1000);
  } catch (err) {
    console.error(`session ${i} (${persona}) failed: ${err.message}`);
    return false;
  } finally {
    await context.close();
  }
  console.log(`session ${String(i + 1).padStart(2)} ${persona}`);
  return true;
}

const personas = pickPersonas(SESSIONS);
const browser = await chromium.launch();
const ok = [];
let next = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < personas.length) {
      const i = next++;
      if (await runOne(browser, personas[i], i)) ok.push(personas[i]);
    }
  })
);
await browser.close();

// The hand count: sessions reaching each step, from the personas that ran.
console.log(`\n${ok.length} sessions sent. Expected funnel ${STEPS.join(" -> ")}:`);
let prev;
STEPS.forEach((step, i) => {
  const n = ok.filter((p) => PERSONAS[p].reaches > i).length;
  const drop = prev === undefined ? "" : `   dropped ${prev - n}`;
  console.log(`  ${i + 1}. ${step.padEnd(20)} ${String(n).padStart(3)} sessions${drop}`);
  prev = n;
});
console.log(`  (not entered: ${ok.filter((p) => PERSONAS[p].reaches === 0).length} sessions that never opened /)`);
```

</details>

With the shop still running:

```bash
npm install && npx playwright install chromium && npm run generate
```

Check: after about a minute it prints

```
50 sessions sent. Expected funnel page:/ -> page:/products/* -> event:add_to_cart -> page:/checkout -> event:order_paid:
  1. page:/                45 sessions
  2. page:/products/*      37 sessions   dropped 8
  3. event:add_to_cart     28 sessions   dropped 9
  4. page:/checkout        20 sessions   dropped 8
  5. event:order_paid      10 sessions   dropped 10
  (not entered: 5 sessions that never opened /)
```

Keep it: it is the answer Grafana must give. (Your own session from step 3 adds 1 to every step.)

## 5. Build the funnel in Grafana

http://localhost:3000 -> More apps -> ouo11y RUM -> **Funnels**, time range **Last 1 hour**.

1. Step 1 is already **Page**, **is**, `/`. Click its value box: it lists the paths seen in the
   range, most frequent first.
2. Step 2: **Page**, **starts with**, `/products/` (type it, then "Use this value"): any product.
3. **Add step**: **Event**, `add_to_cart` (custom event names are suggested too).
4. **Add step**: **Page**, **is**, `/checkout`.
5. **Add step**: **Event**, `order_paid`.
6. **Service**: `tiny-shop-funnels-frontend`, then Enter.

Check: the bars read 45, 37, 28, 20, 10 (one more each if you shopped in step 3), the
generator's numbers. The address bar now holds the funnel
(`...&step=page:/&step=page:/products/*&step=event:add_to_cart&...`): copy it to share it.

What to read under each bar: the big percentage is relative to step 1; **% of previous step** is
the step's own conversion (here checkout -> paid, 50%, the leak); **median · p75** is the time
from the previous step. The 5 deep-link sessions never opened `/`, so they are not in this
funnel; the 3 out-of-order ones added to cart before opening `/` and count for step 1 only.
[docs/funnels.md](../../../docs/funnels.md) has the full rules.

## 6. From a drop-off to the replay

1. Click the hatched **−10** above **order_paid**. The list shows the 10 sessions that reached
   `/checkout` and did not pay, with their last page and how long they took to get stuck.
2. Click **Replay** on a row. The session page opens: a declined one shows `Error: checkout
   failed: card declined` and a failed `POST /api/checkout`; an abandoned one stops on the form.

Check: the replay plays the shopper's path, card input masked.

## Clean up

From `stack`: `docker compose down` (add `-v` to delete the data and the replays), then stop the
two `npm` commands with Ctrl+C.

## When something does not work

| You see | Why | Fix |
|---|---|---|
| `docker compose up` fails with `unable to prepare context` | `OUO11Y_REPO` is not set or not a clone of ouo11y/ouo11y | `export OUO11Y_REPO=<clone root>` in the same terminal |
| No **Funnels** page in the app menu | Grafana runs the released `0.3.0` image | `docker compose up -d --build` after step 2's files; hard-reload the browser |
| The step box suggests nothing | no page views in the range yet, or the time range is too short | shop once (step 3), set **Last 1 hour** |
| Every bar is 0 | step 1 does not match: `/` vs `/home`, or a Service filter typo | check the paths under Sessions -> a session |
| Numbers higher than the generator's | your own sessions, or a second `npm run generate` | expected: every run adds the same 45 / 37 / 28 / 20 / 10 |
| `generate` times out on `Add to cart` | the shop is not on 5173 | `SHOP_URL=http://localhost:<port> npm run generate` |
| Bars lower than expected right after the run | the last events are sent when each page is left | wait 10 s and **Refresh** |
