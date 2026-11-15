# 01. Build a small web app and watch it in ouo

The second guide of the [from-scratch series](README.md). You build Tiny Shop, a two-page React
app with no telemetry, then add `@ouo11y/browser` and find each of its sessions, page views,
clicks, custom events, errors, traces and replay in the stack of [guide 00](00-stack.md). Plan on
about 20 minutes.

```
ouo-from-scratch/
├── stack/      guide 00, running
└── web/        this guide: Vite + React, @ouo11y/browser
    ├── public/products.json
    └── src/
        ├── rum.js       the SDK, started once
        ├── main.jsx     imports rum.js first
        └── App.jsx      the shop
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`ouo-from-scratch/`. When a step says "replace the file", select everything in it and paste the
new content over it.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

The stack of guide 00 is up. From `stack/`, every service is `Up`:

```bash
docker compose ps
```

## Step 1. Create the app

From `ouo-from-scratch/`, scaffold a React app with Vite:

```bash
npm create vite@latest web -- --template react --no-interactive
```

```bash
cd web
```

```bash
npm install
```

The template's stylesheet for its demo page is not used:

```bash
rm src/App.css
```

**Name the page.** Replace `web/index.html`:

<!-- embed: examples/quickstarts/from-scratch/result/web/index.html -->
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tiny Shop</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

## Step 2. A plain shop, no telemetry yet

Three products, served as a static file next to the app. Create `web/public/products.json`:

<!-- embed: examples/quickstarts/from-scratch/result/web/public/products.json -->
```json
[
  { "id": 1, "name": "Coffee", "price": 4 },
  { "id": 2, "name": "Tea", "price": 3 },
  { "id": 3, "name": "Cake", "price": 6 }
]
```

Two pages, `/` and `/cart`, switched with `history.pushState`, and a checkout with a bug on
purpose. Replace `web/src/App.jsx`:

```jsx
import { useEffect, useState } from "react";

// Two pages, / and /cart, switched with history.pushState: no router needed.
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (to) => {
    history.pushState(null, "", to);
    setPath(to);
  };
  return [path, go];
}

export default function App() {
  const [path, go] = usePath();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);

  useEffect(() => {
    fetch("/products.json").then((r) => r.json()).then(setProducts);
  }, []);

  const add = (p) => setCart([...cart, p]);
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    alert(`Paid ${cart[0].total.toFixed(2)} €`);
  };

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <nav>
        <button onClick={() => go("/")}>Products</button>{" "}
        <button onClick={() => go("/cart")}>Cart ({cart.length})</button>
      </nav>

      {path === "/cart" ? (
        <section>
          <h2>Cart</h2>
          <ul>{cart.map((p, i) => <li key={i}>{p.name}</li>)}</ul>
          <label>
            Email <input type="email" placeholder="you@example.com" />
          </label>{" "}
          <button onClick={checkout} disabled={cart.length === 0}>Checkout</button>
        </section>
      ) : (
        <section>
          <h2>Products</h2>
          <ul>
            {products.map((p) => (
              <li key={p.id}>
                {p.name}, {p.price} € <button onClick={() => add(p)}>Add to cart</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
```

Start it, from `web/`:

```bash
npm run dev
```

Open http://localhost:5173. Add two products, open the cart, press **Checkout**: nothing happens
on the page, and the browser console (Cmd+Option+J) shows
`TypeError: Cannot read properties of undefined (reading 'toFixed')`. Nobody but you knows. Leave
the dev server running; it reloads on every save.

## Step 3. Install the SDK

In a second terminal tab, from `web/`:

```bash
npm install @ouo11y/browser@0.4.1
```

| Package | What it does in this app |
|---|---|
| `@ouo11y/browser` | The ouo web SDK: starts sessions, records page views, clicks, frustration, web vitals, errors and custom events as OTLP log records, traces the page load and every `fetch`, records a masked rrweb replay, and sends it all to the collector. Built on the OpenTelemetry JS SDK, which comes with it |

## Step 4. Start the SDK before the app

**`init` once, as early as possible.** The endpoint is the collector of guide 00, the project id
and token are a line of its `projects.htpasswd`. `replay.sessionRate: 1` records every session;
the default is 0, no replay. Create `web/src/rum.js`:

<!-- embed: examples/quickstarts/from-scratch/result/web/src/rum.js -->
```js
// ouo RUM: sessions, page views, clicks, errors, web vitals, fetch spans and replay,
// sent as OTLP to the collector of guide 00.
import { init, recordEvent, setUser } from "@ouo11y/browser";

init({
  endpoint: import.meta.env.VITE_OUO_ENDPOINT ?? "http://localhost:4318",
  projectId: "demo",                             // a line of stack/10-collector/projects.htpasswd
  projectToken: "pt_dev_demo_0000000000000000",  // public: it can only write into project demo
  serviceName: "tiny-shop-web",
  serviceVersion: "1.0.0",
  environment: "local",
  replay: { sessionRate: 1 },                    // record every session (default 0: none)
  debug: import.meta.env.DEV,                    // the SDK's diagnostics in the console
});

export { recordEvent, setUser };
```

**Import it first**, so the SDK sees the first render, the first request and any error. Replace
`web/src/main.jsx`:

<!-- embed: examples/quickstarts/from-scratch/result/web/src/main.jsx -->
```jsx
import "./rum.js"; // first, so the SDK sees the first render, the first fetch and any error
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

**Three additions to the shop.** Replace `web/src/App.jsx`. What changed from step 2:

- `recordEvent("add_to_cart", ...)` in `add`: a custom event with the product, a funnel step later.
- A **Sign in as alice** button calling `setUser("alice")`: every later record carries
  `enduser.id = alice`. Without it there is no user, and no id is made up.
- `data-ouo-unmask` on the product list. The replay masks every text and input on the device
  before a byte leaves the browser (`***`); this attribute shows one subtree as written. The
  email field stays masked.

<!-- embed: examples/quickstarts/from-scratch/result/web/src/App.jsx -->
```jsx
import { useEffect, useState } from "react";
import { recordEvent, setUser } from "./rum.js";

// Two pages, / and /cart, switched with history.pushState: no router needed.
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (to) => {
    history.pushState(null, "", to);
    setPath(to);
  };
  return [path, go];
}

export default function App() {
  const [path, go] = usePath();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);

  useEffect(() => {
    fetch("/products.json").then((r) => r.json()).then(setProducts);
  }, []);

  const add = (p) => {
    setCart([...cart, p]);
    recordEvent("add_to_cart", { "product.name": p.name, "product.price": p.price });
  };
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    alert(`Paid ${cart[0].total.toFixed(2)} €`);
  };

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <nav>
        <button onClick={() => go("/")}>Products</button>{" "}
        <button onClick={() => go("/cart")}>Cart ({cart.length})</button>{" "}
        <button onClick={() => setUser("alice")}>Sign in as alice</button>
      </nav>

      {path === "/cart" ? (
        <section>
          <h2>Cart</h2>
          <ul>{cart.map((p, i) => <li key={i}>{p.name}</li>)}</ul>
          <label>
            Email <input type="email" placeholder="you@example.com" />
          </label>{" "}
          <button onClick={checkout} disabled={cart.length === 0}>Checkout</button>
        </section>
      ) : (
        <section data-ouo-unmask>
          <h2>Products</h2>
          <ul>
            {products.map((p) => (
              <li key={p.id}>
                {p.name}, {p.price} € <button onClick={() => add(p)}>Add to cart</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
```

The page reloads. The console now shows
`[ouo] @ouo11y/browser 0.4.1 started (spec 0.1.0-draft)`.

## Step 5. Make a session

In the app: **Sign in as alice**, **Add to cart** twice, **Cart**, type an email, **Checkout**.

In the browser's Network tab, filter on `4318`: the SDK posts to `/v1/logs` and `/v1/traces`
every 5 seconds, and each answer is `200`. The session id is in the `ouo.session` key of Local
Storage (Application tab), the `id` field: 32 hex characters. Copy it for step 6.

## Step 6. Find it in Grafana

Open http://localhost:3000, **Explore**.

**Events, in Loki.** Pick **Loki**, switch to **Code**, and run:

```logql
{service_name="tiny-shop-web"}
```

Every line is one event. Open one: `event_name` says what it is, `session_id`, `enduser_id`,
`url_full` and the rest are its attributes. Only your session's events, with your id:

```logql
{ouo_project_id="demo"} | session_id="<your session id>"
```

| `event_name` | When |
|---|---|
| `session.start` | The first activity in the tab |
| `browser.navigation` | The page load, and each `pushState` (your two pages) |
| `browser.navigation_timing`, `browser.web_vital` | Load milestones; TTFB, FCP, LCP, CLS, INP |
| `browser.user_action.click` | Every click, with a CSS selector, never the text |
| `ouo.user_action.frustration` | A click with no effect (`dead`), several fast ones (`rage`), or one followed by an error |
| `add_to_cart` | Your `recordEvent` |
| `exception` | The checkout bug, with `exception_message` and the stack |
| `ouo.replay.chunk` | A reference to each replay chunk, without its bytes (those are in Muninn) |

Only the errors of every session:

```logql
{ouo_project_id="demo", event_name="exception"}
```

**Traces, in Tempo.** Pick **Tempo**, **TraceQL**, and run:

```traceql
{ resource.service.name = "tiny-shop-web" }
```

You see `documentLoad` (the page load) and one `GET` per `fetch("/products.json")`. Each span
carries `session.id`, so `{ span.session.id = "<your session id>" }` finds a session's traces.
Tempo makes new traces searchable after a few seconds.

**Replay, in Muninn.** Muninn has no UI: guide 03 plays it. Ask it directly, from any folder:

```bash
curl -s -H 'Authorization: Bearer mrt_dev_0000000000000000' localhost:3400/api/v1/projects/demo/sessions/<your session id>/replays
```

You see one replay, format `rrweb/2`, with its chunk count and size.

## Clean up

Stop the dev server with Ctrl+C. Keep the stack running for [02. A React Native app](02-react-native.md)
or [03. A Grafana plugin](03-plugin.md); both use this web app's dev server again.

## When something does not work

| What you see | Why | Fix |
|---|---|---|
| No `[ouo] ... started` line in the console | `rum.js` is not imported, or not first | Step 4: `import "./rum.js";` is the first line of `main.jsx` |
| Requests to `:4318` fail with a CORS error | The page is not on `localhost` or `127.0.0.1` | The collector allows `http://localhost:*` and `http://127.0.0.1:*`; add your origin to `cors.allowed_origins` in `stack/10-collector/config.yaml` and `docker compose restart otel-collector` |
| `401` on `/v1/logs` | `projectId` or `projectToken` differs from `projects.htpasswd` | Use `demo` / `pt_dev_demo_0000000000000000` |
| `ERR_CONNECTION_REFUSED` on `:4318` | The stack is down, or you moved the port | Start the stack; with a moved port run `VITE_OUO_ENDPOINT=http://localhost:<port> npm run dev` |
| No `session_id` in Loki | The tab never had activity: a session starts on a click, a key or a navigation | Click in the page |
| No replay in Muninn | `replay.sessionRate` is 0 (the default) | Step 4 sets it to 1; reload the page for a new session |
| Every text in the replay is `***` | That is the default masking | `data-ouo-unmask` on what may be shown (step 4) |
| Tempo finds nothing | Search runs a few seconds behind | Wait 10 seconds and run the query again |
