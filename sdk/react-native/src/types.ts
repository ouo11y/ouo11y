/** Primitive attribute values accepted by the public API. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface ServiceOptions {
  /** `service.name`, for example `mobile-store`. */
  name: string;
  /** `service.version`: the app version (pass `Constants.expoConfig.version`). It is the version dimension of health percentages. */
  version: string;
  /** `deployment.environment.name`, for example `local`. */
  environment: string;
}

export interface TracingOptions {
  /**
   * URL prefixes (RegExp or exact strings) that receive `traceparent` and `baggage`
   * headers on outbound fetch requests. Requests to other hosts still get a client span.
   */
  propagateTo?: Array<RegExp | string>;
  /** URLs (RegExp or exact strings) never traced. The ingest URLs derived from `endpoint` / `replayEndpoint` are always ignored. */
  ignoreUrls?: Array<RegExp | string>;
}

export interface SessionOptions {
  /** Default 30 minutes. */
  inactivityTimeoutMs?: number;
  /** Default 4 hours. */
  maxDurationMs?: number;
  /** Background longer than this ends the session on foreground. Default 30 seconds. */
  backgroundTimeoutMs?: number;
}

export interface UserOptions {
  id: string;
}

/**
 * Session replay (ADR-0006): native screenshot capture through the `OuoReplay` Expo module
 * (iOS; Android is a no-op stub). Off unless `enabled: true`. Needs a development build
 * (`npx expo prebuild && npx expo run:ios`); in Expo Go and on web it silently stays off.
 */
export interface ReplayOptions {
  /** Default false. */
  enabled?: boolean;
  /** Seconds between timer frames. Default 1. */
  frameInterval?: number;
  /**
   * Redact labels and React Native `<Text>` (not inputs). Default true. Set to `false` when
   * replays must stay readable; inputs are governed by `maskInputs` and stay redacted.
   */
  maskText?: boolean;
  /** Redact text inputs (`TextInput`, `UITextField`, `UITextView`). Default true. */
  maskInputs?: boolean;
  /** Redact image views. Default true. */
  maskImages?: boolean;
  /** Redact WKWebView. Default true. */
  maskWebViews?: boolean;
}

/** Device attributes the host app can supply (for example from `expo-device`). */
export interface DeviceOptions {
  /** `device.model.identifier`, for example `iPhone15,2`. */
  modelIdentifier?: string;
  /** `device.model.name`, for example `iPhone 14 Pro`. */
  modelName?: string;
  /** `device.manufacturer`, for example `Apple`. */
  manufacturer?: string;
  /** `os.name` override; defaults to `iOS` / `Android` from `Platform.OS`. */
  osName?: string;
  /** `os.version` override; defaults to `Platform.Version`. */
  osVersion?: string;
}

/** AsyncStorage-compatible persistence. Injectable for tests and for non-Expo setups. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ErrorOptions {
  /** Also report `console.error` calls as handled, non-fatal exceptions. Default true. */
  consoleErrors?: boolean;
  /** How long a fatal error waits for the crash marker and the flush before the previous handler runs. Default 2000. */
  fatalFlushTimeoutMs?: number;
}

export interface RUMOptions {
  /**
   * Collector OTLP/HTTP base URL, for example `https://otel.example.com` or
   * `http://localhost:4318` (ADR-0007). The SDK posts traces to `${endpoint}/v1/traces` and
   * events to `${endpoint}/v1/logs`. Requests to the ingest URLs are never traced.
   */
  endpoint: string;
  /**
   * Base URL of the collector's replay receiver; chunks go to `${replayEndpoint}/v1/replay/chunks`.
   * Optional: defaults to `endpoint` with port 4318 replaced by 4319 (the collector's default
   * replay port), or to `endpoint` itself when it uses any other port (a proxy such as
   * `https://otel.example.com` routes `/v1/replay/*` to the receiver itself).
   */
  replayEndpoint?: string;
  /**
   * Project id, the user name of the HTTP Basic credential (`Authorization: Basic
   * base64("<projectId>:<projectToken>")`) sent on every OTLP export and replay upload.
   * Required; `initRUM` throws without it.
   */
  projectId: string;
  /**
   * Project token, the password of the Basic credential. Public by nature (it only grants the
   * right to write telemetry into one project); required, `initRUM` throws without it.
   */
  projectToken: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
  replay?: ReplayOptions;
  session?: SessionOptions;
  user?: UserOptions;
  device?: DeviceOptions;
  errors?: ErrorOptions;
  /** Persistence; defaults to `@react-native-async-storage/async-storage`. */
  storage?: AsyncKeyValueStorage;
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
  debug?: boolean;
}

/** Mirrors the browser SDK's `rum.replay`. No-ops when replay is disabled or the native module is absent. */
export interface RUMReplay {
  pause(): void;
  resume(): void;
  isRecording(): boolean;
}

export interface RUMSession {
  id(): string;
  userId(): string;
  /** Set on the first signals of a session that replaced an ended one. */
  previousId(): string | undefined;
}

export interface RUM {
  setUser(user: UserOptions): void;
  /** Report a handled, non-fatal exception. */
  captureError(err: unknown, context?: Attrs): void;
  /** Emit a custom event (an OTel log record with `event.name = name`). */
  addEvent(name: string, attrs?: Attrs): void;
  /** Emit a `navigation` event and count it as activity. */
  trackNavigation(path: string, attrs?: Attrs): void;
  /** Count a user interaction as session activity (the `RUMProvider` does this for touches). */
  recordActivity(): void;
  replay: RUMReplay;
  session: RUMSession;
  /** Resolves once the persisted session state was read and `session.start` was emitted. */
  ready: Promise<void>;
  /** Force export of pending spans, log records and replay chunks. */
  flush(): Promise<void>;
}
