// All @ouo11y/browser usage lives here. Pages import { rum } and never the SDK.
import { diagnostics, flush, getSessionId, init, recordEvent, recordException, replay, setUser as sdkSetUser, type Attrs } from "@ouo11y/browser";

declare const __OUO_RUM_STUB__: boolean;

export const USER_STORAGE_KEY = "ouo.demo.user_id";

const env = import.meta.env;

function rate(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export const config = {
  // The collector is the only host the SDK talks to: OTLP/HTTP to ${otlpEndpoint}/v1/{traces,logs}.
  // Replay chunks are log records on /v1/logs too (event `ouo.replay.chunk`, scope `ouo.replay`).
  otlpEndpoint: env.VITE_OTLP_ENDPOINT ?? "http://localhost:4318",
  // HTTP Basic project credentials. The token is public, not a secret: it ships in the bundle and only
  // names the project. These are the development values the local stack is provisioned with.
  projectId: env.VITE_OUO_PROJECT_ID ?? "demo",
  projectToken: env.VITE_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
  backendUrl: env.VITE_BACKEND_URL ?? "http://localhost:8081",
  appVersion: env.VITE_APP_VERSION ?? "1.4.2",
  stub: typeof __OUO_RUM_STUB__ !== "undefined" && __OUO_RUM_STUB__,
  debug: env.VITE_RUM_DEBUG === "1",
  // Sampling: fractions 0..1, every session with a full replay by default.
  sessionSampleRate: rate(env.VITE_OUO_SESSION_SAMPLE_RATE, 1),
  replaySampleRate: rate(env.VITE_OUO_REPLAY_SAMPLE_RATE, 1),
  // `buffer`: keep the last minute in memory and send it only after an unhandled error.
  replayMode: env.VITE_OUO_REPLAY_MODE === "buffer" || env.VITE_OUO_REPLAY_MODE === "off" ? env.VITE_OUO_REPLAY_MODE : ("session" as const),
} as const;

export function storedUserId(): string | undefined {
  try {
    return localStorage.getItem(USER_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const initialUser = storedUserId();

init({
  endpoint: config.otlpEndpoint,
  projectId: config.projectId,
  projectToken: config.projectToken,
  serviceName: "web-store",
  serviceVersion: config.appVersion,
  environment: "local",
  // traceparent goes to the backend (another origin), with the session id as baggage so the
  // backend can put it on its own spans and logs.
  propagation: { urls: [`${config.backendUrl}*`], sessionBaggage: true },
  sampling: { sessionRate: config.sessionSampleRate },
  // Replay masks all text and every input by default. The public storefront (header, catalogue,
  // chaos panel) is marked `data-ouo-unmask` so its replay stays readable; the cart, checkout,
  // order and session footer stay masked.
  replay: { mode: config.replayMode, sessionRate: config.replaySampleRate, bufferRate: config.replaySampleRate },
  debug: config.debug,
});
if (initialUser) sdkSetUser(initialUser);

let recording = config.replayMode !== "off";

/** What the pages use: a thin facade over the SDK's functions. */
export const rum = {
  addEvent: (name: string, attrs?: Attrs): void => recordEvent(name, attrs),
  captureError: (err: unknown, attrs?: Attrs): void => recordException(err, attrs),
  replay: {
    pause(): void {
      recording = false;
      replay.stop();
    },
    resume(): void {
      recording = true;
      replay.start();
    },
    isRecording: (): boolean => recording && diagnostics().replayRecording,
  },
  session: {
    id: (): string => getSessionId() ?? "",
    userId: (): string => storedUserId() ?? "",
  },
  flush,
};

export function setUser(id: string): void {
  const trimmed = id.trim();
  try {
    if (trimmed) localStorage.setItem(USER_STORAGE_KEY, trimmed);
    else localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // storage unavailable; the SDK still gets the user for this page
  }
  sdkSetUser(trimmed || null);
}
