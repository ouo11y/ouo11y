// ouo browser SDK init: sessions, errors, fetch tracing, Web Vitals and replay.
import { initRUM } from "@ouo11y/browser";

// The tiny-shop API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector. Moved ports? Set VITE_OUO_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace.
  // Use a RegExp: OpenTelemetry compares a string entry with the whole request URL.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },
  replay: { enabled: true, maskAllInputs: true },
  debug: true,
});
