// All @ouo11y/browser usage lives here. Pages import { rum } and never the SDK.
import { initRUM, type RUM } from "@ouo11y/browser";

declare const __OUO_RUM_STUB__: boolean;

export const USER_STORAGE_KEY = "ouo.demo.user_id";

const env = import.meta.env;

function rate(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export const config = {
  // The collector is the only host the SDK talks to (ADR-0007): OTLP to ${otlpEndpoint}/v1/{traces,logs},
  // replay chunks to the replay receiver, which the SDK derives as port 4319 when the endpoint is on 4318.
  otlpEndpoint: env.VITE_OTLP_ENDPOINT ?? "http://localhost:4318",
  // Optional: only needed when the collector's replay receiver is not on port 4319 of the OTLP host.
  replayEndpoint: env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  // HTTP Basic project credentials. The token is public, not a secret: it ships in the bundle and only
  // names the project. These are the development values the local stack is provisioned with.
  projectId: env.VITE_OUO_PROJECT_ID ?? "demo",
  projectToken: env.VITE_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
  backendUrl: env.VITE_BACKEND_URL ?? "http://localhost:8081",
  appVersion: env.VITE_APP_VERSION ?? "1.4.2",
  stub: typeof __OUO_RUM_STUB__ !== "undefined" && __OUO_RUM_STUB__,
  debug: env.VITE_RUM_DEBUG === "1",
  // Sampling (roadmap 8b): fractions 0..1, all sessions with a full replay by default.
  sessionSampleRate: rate(env.VITE_OUO_SESSION_SAMPLE_RATE, 1),
  replaySampleRate: rate(env.VITE_OUO_REPLAY_SAMPLE_RATE, 1),
  replayOnErrorSampleRate: rate(env.VITE_OUO_REPLAY_ON_ERROR_SAMPLE_RATE, 0),
} as const;

export function storedUserId(): string | undefined {
  try {
    return localStorage.getItem(USER_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const initialUser = storedUserId();

export const rum: RUM = initRUM({
  endpoint: config.otlpEndpoint,
  ...(config.replayEndpoint ? { replayEndpoint: config.replayEndpoint } : {}),
  projectId: config.projectId,
  projectToken: config.projectToken,
  service: { name: "web-store", version: config.appVersion, environment: "local" },
  tracing: { propagateTo: [new RegExp("^" + escapeRegExp(config.backendUrl))] },
  session: { sampleRate: config.sessionSampleRate },
  // Replay masks every input and all text by default (ADR-0003). The public storefront (header,
  // catalogue, chaos panel) is marked `ouo-unmask` so its replay stays readable; the cart,
  // checkout, order and session footer stay masked.
  replay: {
    enabled: true,
    maskAllInputs: true,
    sampleRate: config.replaySampleRate,
    onErrorSampleRate: config.replayOnErrorSampleRate,
  },
  ...(initialUser ? { user: { id: initialUser, attributes: userAttributes(initialUser) } } : {}),
  debug: config.debug,
});

// The app's attributes (ouo.attr.*, docs/specs/attributes.md): the storefront's tenant, so sessions
// can be filtered by it in the plugin. VITE_OUO_TENANT overrides it (e2e and demos of a second tenant).
rum.setAttributes({ tenant: env.VITE_OUO_TENANT || "acme", storefront: "web-store" });

/** The user's attributes: a demo plan derived from the id (`vip-*` users are on `pro`). */
function userAttributes(id: string): { plan: string } {
  return { plan: id.startsWith("vip") ? "pro" : "free" };
}

export function setUser(id: string): void {
  const trimmed = id.trim();
  try {
    if (trimmed) localStorage.setItem(USER_STORAGE_KEY, trimmed);
    else localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // storage unavailable; the SDK still gets the user for this page
  }
  if (trimmed) rum.setUser({ id: trimmed, attributes: userAttributes(trimmed) });
}
