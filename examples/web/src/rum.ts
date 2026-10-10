// All @ouo/browser usage lives here. Pages import { rum } and never the SDK.
import { initRUM, type RUM } from "@ouo/browser";

declare const __OUO_RUM_STUB__: boolean;

export const USER_STORAGE_KEY = "ouo.demo.user_id";

const env = import.meta.env;

export const config = {
  // rum-api is the only host the SDK talks to (ADR-0007): OTLP via /ingest/otlp, replay via /v1/replay/chunks.
  rumApi: env.VITE_RUM_API ?? "http://localhost:8080",
  // Public project identifier, not a secret. The development token every local stack component agrees on.
  projectToken: env.VITE_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
  backendUrl: env.VITE_BACKEND_URL ?? "http://localhost:8081",
  appVersion: env.VITE_APP_VERSION ?? "1.4.2",
  stub: typeof __OUO_RUM_STUB__ !== "undefined" && __OUO_RUM_STUB__,
  debug: env.VITE_RUM_DEBUG === "1",
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
  endpoint: config.rumApi,
  projectToken: config.projectToken,
  service: { name: "web-store", version: config.appVersion, environment: "local" },
  tracing: { propagateTo: [new RegExp("^" + escapeRegExp(config.backendUrl))] },
  replay: { enabled: true, maskAllInputs: true },
  ...(initialUser ? { user: { id: initialUser } } : {}),
  debug: config.debug,
});

export function setUser(id: string): void {
  const trimmed = id.trim();
  try {
    if (trimmed) localStorage.setItem(USER_STORAGE_KEY, trimmed);
    else localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // storage unavailable; the SDK still gets the user for this page
  }
  if (trimmed) rum.setUser({ id: trimmed });
}
