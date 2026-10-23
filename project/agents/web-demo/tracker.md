# web-demo tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | `examples/ouo-web` scaffold: Vite 7, React 18, TypeScript strict, react-router 6 | done |
| 2026-10-06 | Pages `/`, `/products/:id`, `/cart`, `/checkout`, `/order/:id`, `/chaos`, floating chaos drawer | done |
| 2026-10-06 | `src/rum.ts` (all SDK usage), `src/rum-stub.ts` (`VITE_RUM_STUB=1`), `src/api.ts` (`x-user-id`) | done |
| 2026-10-06 | Header user control, footer session / user ids, `add_to_cart` and `checkout_submitted` events | done |
| 2026-10-06 | Browser click-through against the backend on :8082 (stub SDK) | done |
| 2026-10-06 | Wire the real `@ouo11y/browser` package and verify in Tempo (19 traces, 15 joined with backend) and Loki (16 events) | done |
| 2026-10-06 | README with run instructions, demo script, Grafana queries | done |
| 2026-10-23 | Batch 3 (by sdk-browser): `@ouo11y/browser/react` boundary and route hook, Chaos buttons (render error, long task, dead button), sampling env vars, journey and verify in Chromium / Firefox / WebKit with vitals, clicks, long frames and interaction-span checks | done |
