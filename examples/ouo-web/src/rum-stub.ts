// Local stand-in for @ouo11y/browser, used only when VITE_RUM_STUB=1.
// It implements the Phase 2 SDK contract and logs every call to the console
// so the storefront can be developed and demoed before the real package builds.

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface RUMServiceConfig {
  name: string;
  version: string;
  environment: string;
}

export interface RUMConfig {
  /** Collector OTLP/HTTP base URL (0.2.0, ADR-0007). */
  endpoint: string;
  /** Replay receiver base; the real SDK derives it (4318 -> 4319) when absent. */
  replayEndpoint?: string;
  /** Basic auth username; the real SDK throws when it is empty. */
  projectId: string;
  /** Basic auth password (public); the real SDK throws when it is empty. */
  projectToken: string;
  service: RUMServiceConfig;
  tracing?: { propagateTo?: Array<RegExp | string> };
  replay?: { enabled?: boolean; maskAllInputs?: boolean };
  user?: { id: string };
  debug?: boolean;
}

export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
}

export interface RUMSession {
  id(): string;
  userId(): string;
}

export interface RUM {
  setUser(user: { id: string }): void;
  captureError(err: unknown, ctx?: Attrs): void;
  addEvent(name: string, attrs?: Attrs): void;
  replay: RUMReplay;
  session: RUMSession;
  flush(): Promise<void>;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "stub-" + Math.random().toString(16).slice(2);
}

export function initRUM(config: RUMConfig): RUM {
  if (!config.projectId) throw new Error("[ouo stub] initRUM: `projectId` is required");
  if (!config.projectToken) throw new Error("[ouo stub] initRUM: `projectToken` is required");
  const sessionId = uuid();
  let userId: string = config.user?.id ?? "anon-" + uuid().slice(0, 8);
  let recording = config.replay?.enabled !== false;
  const log = (...args: unknown[]) => console.info("[ouo stub]", ...args);
  log("initRUM", { ...config, projectToken: "<redacted>" });
  return {
    setUser(user) {
      userId = user.id;
      log("setUser", user);
    },
    captureError(err, ctx) {
      log("captureError", err, ctx);
    },
    addEvent(name, attrs) {
      log("addEvent", name, attrs);
    },
    replay: {
      pause() {
        recording = false;
        log("replay.pause");
      },
      resume() {
        recording = true;
        log("replay.resume");
      },
      isRecording: () => recording,
    },
    session: {
      id: () => sessionId,
      userId: () => userId,
    },
    async flush() {
      log("flush");
    },
  };
}
