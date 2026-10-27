// ouo browser SDK init: sessions, errors, fetch tracing, and session replay with its sampling,
// masking and click signals.
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
  service: { name: "tiny-shop-replay-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace and the
  // replay, the click and the backend error share one trace id.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },

  // Session sampling comes first: a session that is not sampled sends nothing, replay included.
  session: { sampleRate: 1 },

  // New in this example: session replay (rrweb).
  replay: {
    enabled: true,
    // Of the sampled sessions, the share recorded from the first page. 1 here so every session of
    // the quickstart has a replay; 0.1 is a common production start.
    sampleRate: 1,
    // Of the sessions NOT picked by sampleRate, the share that keeps the last 30 to 60 s in memory
    // and uploads it (and the rest of the session) after the first error. Only matters when
    // sampleRate < 1: try sampleRate 0 and onErrorSampleRate 1 to see replays of errors only.
    onErrorSampleRate: 1,
    // Every <input> value is replaced by asterisks in the replay: email, password, card number.
    // Default true. For finer control leave it on and use the classes below on other elements.
    maskAllInputs: true,
  },
  // Rage clicks (3 clicks within 1 s in one spot) and dead clicks (a button click after which
  // nothing changed and nothing was requested) are on by default; the defaults, spelled out:
  clicks: { rageClicks: { threshold: 3, windowMs: 1000, radiusPx: 30 }, deadClicks: true },
  debug: true,
});
