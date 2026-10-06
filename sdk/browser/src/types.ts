/** Primitive attribute values accepted by the public API. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface ServiceOptions {
  /** `service.name`, for example `web-store`. */
  name: string;
  /** `service.version`, the app version dimension used for health percentages. */
  version: string;
  /** `deployment.environment.name`, for example `local`. */
  environment: string;
}

export interface TracingOptions {
  /**
   * Origins (as RegExp or exact strings) that receive `traceparent` and `baggage`
   * headers on outbound fetch / XHR requests. Same-origin requests always get them.
   */
  propagateTo?: Array<RegExp | string>;
  /** URLs (RegExp or exact strings) never traced. The OTLP and replay endpoints are always ignored. */
  ignoreUrls?: Array<RegExp | string>;
  /** Record a `documentLoad` span from Navigation Timing. Default true. */
  documentLoad?: boolean;
}

export interface ReplayOptions {
  /** When false rrweb is never loaded. Default true. */
  enabled?: boolean;
  /** Mask every input value. Default true. */
  maskAllInputs?: boolean;
  /** Fraction of sessions that get a replay, decided once per session and persisted. Default 1. */
  sampleRate?: number;
  /** Flush a chunk at least this often. Default 5000. */
  flushIntervalMs?: number;
  /** Flush a chunk when the buffered events exceed this many bytes. Default 262144 (256 KB). */
  maxChunkBytes?: number;
}

export interface SessionOptions {
  /** Default 30 minutes. */
  inactivityTimeoutMs?: number;
  /** Default 4 hours. */
  maxDurationMs?: number;
}

export interface UserOptions {
  id: string;
}

export interface RUMOptions {
  /** OTLP/HTTP base URL. The SDK appends `/v1/traces` and `/v1/logs`. */
  endpoint: string;
  /** rum-api base URL. The SDK posts replay chunks to `${replayEndpoint}/v1/replay/chunks`. */
  replayEndpoint?: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
  replay?: ReplayOptions;
  session?: SessionOptions;
  user?: UserOptions;
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
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
  setUser(user: UserOptions): void;
  /** Report a handled, non-fatal exception. */
  captureError(err: unknown, context?: Attrs): void;
  /** Emit a custom event (an OTel log record with `event.name = name`). */
  addEvent(name: string, attrs?: Attrs): void;
  replay: RUMReplay;
  session: RUMSession;
  /** Force export of pending spans, log records and replay chunks. */
  flush(): Promise<void>;
}
