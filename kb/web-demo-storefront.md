# web demo storefront (examples/web)

Status: filled in Phase 2 by web-demo.

## Question

How is the demo React storefront wired to the demo backend and to `@ouo/browser`, and what tripped us up?

## What was tried

- Vite 7 + React 18 + react-router 6, TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- All SDK calls go through `src/rum.ts`; pages import `rum` from there. The SDK package is a workspace link (`node_modules/@ouo/browser -> sdk/browser`) consumed from its `dist/`, so `npm run -w sdk/browser build` must run before `npm run -w examples/web build`.
- Before the SDK existed the app was built against `src/rum-stub.ts`, selected with `VITE_RUM_STUB=1` via a Vite `resolve.alias` plus a second tsconfig (`tsconfig.stub.json` with `paths`). Two tsconfigs rather than an ambient `declare module "@ouo/browser"` because TypeScript resolves ambient module declarations before real packages, so a stub `.d.ts` would shadow the real types once the package appears.

## What works

- Backend contract (`examples/backend`): carts are per user, keyed by baggage `user.id` first, then the `x-user-id` header. The app stores the user id in `localStorage` (`ouo.demo.user_id`), calls `rum.setUser`, and sends `x-user-id`; both agree, so the cart is stable across reloads.
- `POST /api/checkout` body must be exactly `{"paymentMethod": "card" | "broken-card"}`. The decoder rejects unknown fields with `400 invalid JSON body: json: unknown field "name"`. Name, email and card number therefore never leave the browser; they exist for replay masking (`ouo-mask`, `ouo-block`, `maskAllInputs`).
- Checkout response is `{orderId, total, items}` where `items` is a **count**, not the line items. The order page carries the cart lines through router navigation state.
- Fault flags from the README work as documented: `?delay=2000` adds ~2 s, `?fail=500` returns `{"error":"payment gateway unavailable"}`, `?fail=timeout` hangs 30 s; the app aborts with `AbortController` after 5 s (`DOMException` named `TimeoutError`).
- Product images in the backend payload point to paths that do not exist; the app renders a gradient tile with the product initial instead of a broken `<img>`.

## Gotchas

- React 18 development builds re-throw errors thrown in event handlers through `invokeGuardedCallback`, so an uncaught error from a click handler reaches `window.onerror` twice in `vite dev` and once in the production build. Count exception events in Loki with that in mind.
- Vite HMR of a module that creates a React context (`cart.tsx`) throws `useCart must be used inside CartProvider` once until the page reloads; harmless, dev only.
- The `.env.example` and `src/rum.ts` defaults are the stock ports (backend 8081, OTLP 4318) since 2026-10-10; the dev Mac's alternate ports (8082, 4328) live only in the gitignored `examples/web/.env` and `examples/mobile/.env`.
