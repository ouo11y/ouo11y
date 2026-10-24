// ouo browser SDK init. The bite of this quickstart is the session: when it starts, what ends it,
// and how it follows the user (setUser / clearUser) and the browser (device.id).
import { initRUM } from "@ouo11y/browser";

// The API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

// The "Short inactivity timeout" switch on the page stores its choice here and reloads: the
// timeout is an init option, read once.
export const SHORT_TIMEOUT_KEY = "tiny-shop.short-timeout";
export const shortTimeout = localStorage.getItem(SHORT_TIMEOUT_KEY) === "1";

export const rum = initRUM({
  // The ouo collector, the only thing the page talks to. Moved ports? Set VITE_OUO_ENDPOINT and
  // VITE_OUO_REPLAY_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-sessions-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage` (session.id, user.id), so its spans join the
  // browser's trace.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },

  session: {
    // Defaults: 30 min without activity ends the session (`inactivity`), and no session lasts more
    // than 4 h (`max_duration`). The switch shortens inactivity to 1 min so you can watch it.
    inactivityTimeoutMs: shortTimeout ? 60_000 : 30 * 60_000,
    maxDurationMs: 4 * 60 * 60_000,
    sampleRate: 1, // keep every session: this is a demo
  },
  replay: { enabled: true, sampleRate: 1, maskAllInputs: true },
  // `[ouo] session started <id> (previous <id>)` and the other decisions in the console.
  debug: true,
});
