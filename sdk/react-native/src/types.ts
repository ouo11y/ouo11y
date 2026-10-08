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
  /** URLs (RegExp or exact strings) never traced. The OTLP endpoint is always ignored. */
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
  /** OTLP/HTTP base URL. The SDK appends `/v1/traces` and `/v1/logs`. */
  endpoint: string;
  service: ServiceOptions;
  tracing?: TracingOptions;
  session?: SessionOptions;
  user?: UserOptions;
  device?: DeviceOptions;
  errors?: ErrorOptions;
  /** Persistence; defaults to `@react-native-async-storage/async-storage`. */
  storage?: AsyncKeyValueStorage;
  /** Log SDK decisions to the console with the `[ouo]` prefix. */
  debug?: boolean;
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
  session: RUMSession;
  /** Resolves once the persisted session state was read and `session.start` was emitted. */
  ready: Promise<void>;
  /** Force export of pending spans and log records. */
  flush(): Promise<void>;
}
