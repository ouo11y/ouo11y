// All @ouo/browser usage lives here. Pages import { rum } and never the SDK.
import { initRUM, type RUM } from "@ouo/browser";

declare const __OUO_RUM_STUB__: boolean;

export const USER_STORAGE_KEY = "ouo.demo.user_id";

const env = import.meta.env;

export const config = {
  otlpEndpoint: env.VITE_OTLP_ENDPOINT ?? "http://localhost:4318",
  rumApi: env.VITE_RUM_API ?? "http://localhost:8080",
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
  endpoint: config.otlpEndpoint,
  replayEndpoint: config.rumApi,
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
