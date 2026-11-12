/**
 * `@ouo11y/browser`: the ouo Real User Monitoring SDK for browsers, built on the OpenTelemetry
 * API and SDK. It implements the ouo client SDK spec, version {@link SPEC_VERSION}.
 *
 * The public API is the set of functions exported here (SDK spec section 3.1). Every one of them
 * is safe to call before `init`, after `shutdown`, on the server and with any argument: it is
 * then a no-op and never throws (API-1). The golden rule behind all of it: the app must not pay
 * for the SDK's failures.
 */
import { ProxyTracerProvider, type TracerProvider } from "@opentelemetry/api";
import { createNoopLogger, type LoggerProvider } from "@opentelemetry/api-logs";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer/build/esm/logs/json";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer/build/esm/trace/json";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { resolveConfig, type Config } from "./config";
import { systemClock, type TimerHandle } from "./core/clock";
import { DropCounter, type DropReason } from "./core/drops";
import { hasSecureRandom } from "./core/ids";
import { appAttributes, reservedName, truncate, type Attrs } from "./core/limits";
import { sanitizeStack, sanitizeUrl, type UrlPolicy } from "./core/url";
import { attempt, configureGuard, contain, guardedFailures, injectFault, listen, quiet } from "./guard";
import { createLogger, silentLogger, type DebugLogger } from "./logger";
import { Emitter } from "./pipeline/emitter";
import { createPipeline, installXhrHeaderGuard, type Pipeline } from "./pipeline/otel";
import { ReplayController } from "./replay/controller";
import { SessionManager, SESSION_KEY, type SessionRecord, type Stamp } from "./session/manager";
import { ConsentStorage } from "./session/storage";
import { installClicks } from "./signals/clicks";
import { exceptionAttributes, installErrorCapture, markReported } from "./signals/errors";
import { installNavigation, ViewState, type NavigationHandle } from "./signals/navigation";
import { installNetwork } from "./signals/network";
import { installWebVitals } from "./signals/vitals";
import { Http } from "./transport/http";
import { OutboxDrainer, TelemetryQueue } from "./transport/queue";
import { ResilientOutbox, type Outbox } from "./transport/store";
import type { Consent, NavigationOptions, OuoConfig } from "./types";
import { SDK_NAME, SDK_VERSION, SPEC_VERSION } from "./version";

export type * from "./types";
export { basicAuth } from "./config";
export { SDK_NAME, SDK_VERSION, SPEC_VERSION, SCHEMA_URL } from "./version";

type ConsentState = "pending" | "granted" | "denied";

/** What `diagnostics()` returns: counts only, never a payload (ERR-8). */
export interface Diagnostics {
  /** `running`, `off` (never started or shut down) or `disabled` (turned itself off). */
  state: "running" | "off" | "disabled";
  sessionId: string | undefined;
  /** SDK exceptions contained since `init`. */
  internalErrors: number;
  /** Records dropped since `init`, by `signal` and `reason`. */
  dropped: Array<{ signal: string; reason: string; count: number }>;
  sent: { logs: number; spans: number; requests: number; bytes: number };
  replayRecording: boolean;
  consent: { telemetry: ConsentState; replay: ConsentState };
}

const jsonRejected = (kind: "logs" | "traces") => (body: Uint8Array): number => {
  const serializer = kind === "logs" ? JsonLogsSerializer : JsonTraceSerializer;
  const res = serializer.deserializeResponse(body) as { partialSuccess?: { rejectedLogRecords?: number | string; rejectedSpans?: number | string } } | undefined;
  return Number(res?.partialSuccess?.rejectedLogRecords ?? res?.partialSuccess?.rejectedSpans ?? 0) || 0;
};

class Runtime {
  readonly clock = systemClock;
  readonly drops = new DropCounter();
  readonly view = new ViewState();
  readonly log: DebugLogger;
  private readonly storage: ConsentStorage;
  private readonly urlPolicy: UrlPolicy;
  private readonly http: Http;
  private outboxInstance: ResilientOutbox | null = null;
  readonly pipeline: Pipeline;
  private readonly emitter: Emitter;
  private readonly session: SessionManager;
  private readonly logs: TelemetryQueue<ReadableLogRecord>;
  private readonly traces: TelemetryQueue<ReadableSpan>;
  private drainer: OutboxDrainer | null = null;
  private readonly replay: ReplayController;
  private navigation: NavigationHandle | undefined;
  private readonly cleanup: Array<() => unknown> = [];
  private globals: Attrs = {};
  private telemetryConsent: ConsentState;
  private replayConsent: ConsentState;
  private unloading = false;
  private dropTimer: TimerHandle | null = null;
  private releaseTab: (() => void) | undefined;
  private documentUrlRaw = "";
  private documentUrlClean = "";
  private readonly networkListeners = new Set<() => void>();
  private readonly navigationListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  stopped = false;
  disabled = false;

  constructor(readonly cfg: Config) {
    this.log = createLogger(cfg.debug);
    this.telemetryConsent = this.replayConsent = cfg.consentRequired ? "pending" : "granted";
    this.storage = new ConsentStorage(!cfg.consentRequired);
    this.urlPolicy = { queryAllow: cfg.privacy.urlQueryAllow, keepFragment: cfg.privacy.keepUrlFragment, hook: cfg.sanitizeUrl };
    this.http = new Http({ headers: cfg.headers, timeoutMs: cfg.transport.timeoutMs });

    const gate = (): "open" | "hold" => (this.telemetryConsent === "pending" ? "hold" : "open");
    const hidden = (): boolean => this.hidden();
    const queue = { http: this.http, outbox: () => this.outbox(), onStored: (id: number) => this.drainer?.own(id), drops: this.drops, settings: cfg.transport, logger: this.log, gate, hidden };
    this.logs = new TelemetryQueue<ReadableLogRecord>({
      ...queue,
      signal: "logs",
      url: cfg.logsUrl,
      serialize: (items) => JsonLogsSerializer.serializeRequest(items),
      rejected: jsonRejected("logs"),
      isBypass: (r) => r.eventName === "exception" && r.attributes["ouo.exception.handled"] === false,
      nameOf: (r) => r.eventName ?? "log",
    });
    this.traces = new TelemetryQueue<ReadableSpan>({
      ...queue,
      signal: "traces",
      url: cfg.tracesUrl,
      serialize: (items) => JsonTraceSerializer.serializeRequest(items),
      rejected: jsonRejected("traces"),
      isBypass: () => false,
      nameOf: () => "span",
    });

    const stamp = (): Stamp => this.session.stamp();
    const globalAttributes = (): Attrs => (this.view.name ? { ...this.globals, "ouo.view.name": this.view.name } : this.globals);
    this.pipeline = createPipeline({
      cfg,
      drops: this.drops,
      stamp,
      viewId: () => this.view.id,
      documentUrl: () => this.documentUrl(),
      sanitize: (url) => this.sanitize(url),
      globalAttributes,
      active: () => this.active(),
      logSink: (record) => this.logs.add(record),
      spanSink: (span) => this.traces.add(span),
      baggageSessionId: () => (this.telemetryConsent === "granted" ? this.session.id() : undefined),
      onSpanStart: () => this.notify(this.networkListeners),
    });
    this.emitter = new Emitter({
      logger: this.pipeline.logger,
      clock: this.clock,
      drops: this.drops,
      stamp,
      viewId: () => this.view.id,
      documentUrl: () => this.documentUrl(),
      globalAttributes,
      beforeSend: cfg.beforeSend,
      bypassCap: cfg.sampling.bypassCap,
      active: () => this.active(),
    });
    this.session = new SessionManager({
      storage: this.storage,
      inactivityTimeoutMs: cfg.session.inactivityTimeoutMs,
      maxDurationMs: cfg.session.maxDurationMs,
      sessionRate: cfg.sampling.sessionRate,
      hooks: {
        onStart: (rec) => {
          if (!rec.s) return;
          const attrs: Attrs = { "ouo.session.sample_rate": rec.rate };
          if (rec.prev && rec.prev !== rec.id) attrs["session.previous_id"] = rec.prev;
          this.emitter.emit("session.start", attrs, { stamp: this.stampOf(rec), first: true, time: rec.start });
        },
        onEnd: (rec, reason) => {
          // The end of a session whose consent was withdrawn is the last record of that consent:
          // it is announced under the session lock, after the state has changed.
          if (rec.s) this.emitter.emit("session.end", { "ouo.session.end_reason": reason }, { stamp: this.stampOf(rec), first: true, time: rec.last, always: reason === "consent" });
        },
        onChange: () => {
          this.replay.evaluate();
          this.armDropReport();
        },
        hold: () => this.emitter.hold(),
        release: () => this.emitter.release(),
        restamp: (from, to) => this.emitter.restamp(from, to),
      },
    });
    this.replay = new ReplayController({
      cfg,
      clock: this.clock,
      drops: this.drops,
      log: this.log,
      storage: this.storage,
      makeRecord: this.pipeline.makeReplayRecord,
      http: this.http,
      outbox: () => this.outbox(),
      session: () => this.session.current(),
      viewId: () => this.view.id,
      sanitize: (url) => this.sanitize(url),
      consented: () => this.replayConsent === "granted" && this.telemetryConsent === "granted",
    });
  }

  // ---- state ----

  active(): boolean {
    return !this.stopped && !this.disabled && this.telemetryConsent !== "denied";
  }

  private hidden(): boolean {
    return this.unloading || document.visibilityState === "hidden";
  }

  /** The outbox, created on first use and only once storage is allowed (PRV-1). */
  private outbox(): Outbox | null {
    if (!this.cfg.transport.persist || this.telemetryConsent !== "granted") return null;
    this.outboxInstance ??= new ResilientOutbox({ maxBytes: this.cfg.transport.persistMaxBytes, onDegrade: () => this.drops.add("outbox", "storage_error") });
    return this.outboxInstance;
  }

  sanitize(url: string): string {
    return sanitizeUrl(url, this.urlPolicy);
  }

  private documentUrl(): string {
    const raw = location.href;
    if (raw !== this.documentUrlRaw) {
      this.documentUrlRaw = raw;
      this.documentUrlClean = this.sanitize(raw);
    }
    return this.documentUrlClean;
  }

  private stampOf(rec: SessionRecord): Stamp {
    return { id: rec.id, sampled: rec.s, expired: false, user: rec.u };
  }

  private notify(listeners: Set<() => void>): void {
    for (const fn of listeners) attempt(fn);
  }

  private subscribe(listeners: Set<() => void>) {
    return (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
  }

  /** User presence. No session starts or is kept alive once telemetry consent is denied. */
  private activity(): void {
    if (this.active()) this.session.activity();
  }

  // ---- start ----

  start(): void {
    const { cfg } = this;
    const inst = cfg.instrumentations;
    const on = <T>(install: () => T): T | undefined => attempt(install);

    // Network first: its patches must be in place before the page's first request.
    this.cleanup.push(installXhrHeaderGuard());
    const offNetwork = on(() =>
      installNetwork({ tracerProvider: this.pipeline.rumTracerProvider, fetch: inst.fetch, xhr: inst.xhr, propagateTo: cfg.propagation.urls, ignoreUrls: cfg.otel.ignoreUrls, endpoint: cfg.endpoint }),
    );
    if (offNetwork) this.cleanup.push(offNetwork);

    this.cleanup.push(
      this.emitter.subscribe((name, _attrs, bypass) => {
        if (!bypass) return;
        // Any bypass-set record triggers a buffered replay (SMP-12) and marks an error click.
        this.replay.trigger("error");
        if (name === "exception") this.notify(this.errorListeners);
      }),
    );

    // The view and the session exist before the first record, so `session.start` and the
    // page-load navigation carry both.
    this.view.next(undefined, true);
    this.session.start(document.visibilityState === "visible");
    const act = (): void => this.activity();
    const passive = { capture: true, passive: true } as const;
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove"]) this.cleanup.push(listen(globalThis, type, act, passive));
    this.cleanup.push(
      listen(globalThis, "storage", (e) => {
        const ev = e as StorageEvent;
        if (ev.key === SESSION_KEY) this.session.handleStorage(ev.newValue);
      }),
    );

    this.navigation = on(() =>
      installNavigation({
        clock: this.clock,
        view: this.view,
        tracer: this.pipeline.tracer,
        sanitize: (url) => this.sanitize(url),
        emit: (name, attrs, o) => this.emitter.emit(name, attrs, o),
        onNavigation: () => {
          // A navigation is activity when someone can see it: a tab loading in the background
          // starts no session until it is shown.
          if (document.visibilityState === "visible") act();
          this.notify(this.navigationListeners);
        },
        navigation: inst.navigation,
        hashNavigation: inst.hashNavigation,
        documentLoad: inst.documentLoad,
        navigationTiming: inst.navigationTiming,
        resourceTiming: inst.resourceTiming,
        ignoreResource: (url) => url.startsWith(`${cfg.endpoint}/v1/`),
      }),
    );
    if (this.navigation) this.cleanup.push(this.navigation.uninstall);

    if (inst.errors) {
      const off = on(() =>
        installErrorCapture({
          emit: (attrs) => this.emitter.emit("exception", attrs, { severity: "ERROR", bypass: true }),
          sanitize: (url) => this.sanitize(url),
          sanitizeStack: (stack) => sanitizeStack(stack, this.urlPolicy),
        }),
      );
      if (off) this.cleanup.push(off);
    }
    if (inst.clicks || inst.frustration) {
      const off = on(() =>
        installClicks({
          clock: this.clock,
          clicks: inst.clicks,
          frustration: inst.frustration,
          emitClick: (attrs) => this.emitter.emit("browser.user_action.click", attrs),
          emitFrustration: (attrs, time) => this.emitter.emit("ouo.user_action.frustration", attrs, { time }),
          onNetwork: this.subscribe(this.networkListeners),
          onNavigation: this.subscribe(this.navigationListeners),
          onError: this.subscribe(this.errorListeners),
        }),
      );
      if (off) this.cleanup.push(off);
    }
    // Page hide, step one (LIF-7): requests still in flight end as abandoned spans. Registered
    // before the vitals' own page-hide listener, which is step two.
    this.cleanup.push(listen(globalThis, "pagehide", () => this.pipeline.abandonOpenSpans()));
    // Before the lifecycle listeners below: final vitals are emitted on hide and must be in the flush.
    if (inst.webVitals) {
      const off = on(() =>
        installWebVitals({
          emit: (attrs, o) => this.emitter.emit("browser.web_vital", attrs, o),
          hardViewId: () => this.view.hardId,
          attributionBody: inst.vitalAttributionBody,
        }),
      );
      if (off) this.cleanup.push(off);
    }

    // Opened now, not at page hide: a database opened while the page is closing never gets written.
    this.outbox();
    this.installLifecycle();
    this.drops.onFirst(() => this.armDropReport());
    this.holdTabLock();
    this.replay.evaluate();
    this.drainer = new OutboxDrainer({
      outbox: () => this.outbox(),
      http: this.http,
      urls: { logs: cfg.logsUrl, traces: cfg.tracesUrl },
      rejected: { logs: jsonRejected("logs"), traces: jsonRejected("traces") },
      drops: this.drops,
      ttlMs: cfg.transport.persistTtlMs,
      retryInitialMs: cfg.transport.retryInitialMs,
      retryMaxMs: cfg.transport.retryMaxMs,
      gate: () => (this.telemetryConsent === "granted" ? "open" : "hold"),
      hidden: () => this.hidden(),
    });
    this.drainer.schedule(1000);
    const recover = this.clock.setTimeout(() => this.replay.recover(), 1500);
    this.cleanup.push(() => this.clock.clearTimeout(recover));
    this.log.log(`${SDK_NAME} ${SDK_VERSION} started (spec ${SPEC_VERSION})`);
  }

  /** A shared Web Lock held while this tab runs the SDK: `shutdown` uses it to tell whether it is the last one. */
  private holdTabLock(): void {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    if (!locks?.request) return;
    void quiet(
      locks.request("ouo.tab", { mode: "shared" }, () => new Promise<void>((resolve) => {
        this.releaseTab = resolve;
        if (this.stopped) resolve();
      })),
    );
  }

  /** Whether no other tab of this origin runs the SDK: it holds the only `ouo.tab` lock. */
  private async lastTab(): Promise<boolean> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    if (!locks?.query) return true;
    try {
      const held = (await locks.query()).held ?? [];
      return held.filter((l) => l.name === "ouo.tab").length <= 1;
    } catch {
      return true;
    }
  }

  // ---- lifecycle (SDK spec section 4.2) ----

  private installLifecycle(): void {
    const off = (fn: () => void): void => void this.cleanup.push(fn);
    off(
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.session.persist();
          this.reportDrops();
          this.replay.onHidden();
          void this.logs.flush();
          void this.traces.flush();
        } else {
          this.activity();
          this.replay.onVisible();
          this.drainer?.schedule(0);
          this.replay.recover();
        }
      }),
    );
    off(
      listen(globalThis, "pagehide", () => {
        // In this order (LIF-7): open spans were abandoned and final vitals emitted by the two
        // listeners registered before this one; now close the replay chunk and end the stream,
        // flush telemetry, then replay.
        this.unloading = true;
        const engine = this.replay.onPageHide();
        this.reportDrops();
        void this.logs.flush();
        void this.traces.flush();
        attempt(() => engine?.flushUnload());
        this.session.persist();
      }),
    );
    off(
      listen(globalThis, "pageshow", (e) => {
        this.unloading = false;
        if (!(e as PageTransitionEvent).persisted) return;
        // Restored from the back/forward cache (LIF-8): a new view, the session re-evaluated, a new replay stream.
        this.navigation?.restored();
        this.activity();
        this.replay.evaluate();
      }),
    );
    off(
      listen(document, "freeze", () => {
        void this.logs.flush();
        void this.traces.flush();
      }),
    );
    off(listen(document, "resume", () => void this.session.stamp()));
    off(listen(globalThis, "online", () => this.drainer?.schedule(0)));
  }

  // ---- drop reports (ERR-7) ----

  private armDropReport(): void {
    if (this.dropTimer !== null || this.stopped) return;
    this.dropTimer = this.clock.setTimeout(() => {
      this.dropTimer = null;
      this.reportDrops();
    }, this.cfg.transport.flushIntervalMs);
  }

  private reportDrops(): void {
    if (!this.active()) return;
    const stamp = this.session.stamp();
    // No session to send them in: the counts wait for the next one.
    if (stamp.expired || !stamp.sampled) return;
    for (const r of this.drops.take()) {
      this.emitter.emit("ouo.sdk.dropped", { "ouo.sdk.drop.signal": r.signal, "ouo.sdk.drop.reason": r.reason, "ouo.sdk.drop.count": r.count }, { internal: true, stamp });
    }
  }

  // ---- public API ----

  sessionId(): string | undefined {
    return this.active() ? this.session.id() : undefined;
  }

  restartSession(): void {
    if (this.active()) this.session.restart();
  }

  setUser(id: string | null): void {
    this.session.setUser(id);
  }

  setGlobalAttributes(map: unknown): void {
    this.globals = appAttributes(map, (reason) => this.drops.add("attribute", reason));
  }

  recordEvent(name: string, attributes: unknown, body: unknown): void {
    if (name === "" || reservedName(name)) {
      this.drops.add(truncate(name || "event", 64), "reserved_name");
      return;
    }
    const attrs = appAttributes(attributes, (reason) => this.drops.add("attribute", reason));
    this.emitter.emit(truncate(name, 128), attrs, body === undefined ? {} : { body: safeBody(body) });
  }

  recordException(error: unknown, attributes: unknown, sdk: Attrs = {}): void {
    const attrs = appAttributes(attributes, (reason) => this.drops.add("attribute", reason));
    const handled = attrs["ouo.exception.handled"] === false ? false : true;
    markReported(error);
    this.emitter.emit(
      "exception",
      {
        ...attrs,
        ...sdk,
        ...exceptionAttributes(error, { source: "manual", handled, sanitize: (url) => this.sanitize(url), sanitizeStack: (stack) => sanitizeStack(stack, this.urlPolicy) }),
      },
      { severity: "ERROR", bypass: !handled },
    );
  }

  trackNavigation(name: string, o: NavigationOptions): void {
    this.navigation?.track(truncate(name, 256), { url: typeof o.url === "string" ? o.url : undefined, id: typeof o.id === "string" ? o.id : undefined });
  }

  replayApi(action: "start" | "stop" | "capture"): void {
    if (!this.active()) return;
    if (action === "start") this.replay.start();
    else if (action === "stop") this.replay.stop();
    else this.replay.trigger("manual");
  }

  setConsent(c: Consent): void {
    if (typeof c.telemetry === "boolean") {
      if (c.telemetry && this.telemetryConsent !== "granted") {
        const wasDenied = this.telemetryConsent === "denied";
        this.telemetryConsent = "granted";
        this.storage.persist();
        this.outbox();
        // After a withdrawal the next session is a new start with no previous id (PRV-4).
        if (wasDenied) this.session.start(document.visibilityState === "visible");
        else this.session.persist();
        void this.logs.flush();
        void this.traces.flush();
        this.drainer?.schedule(0);
      } else if (!c.telemetry && this.telemetryConsent !== "denied") {
        const wasGranted = this.telemetryConsent === "granted";
        // What was collected with consent may still leave; what was only buffered may not (PRV-2).
        if (wasGranted) this.session.end("consent");
        else {
          this.logs.discard();
          this.traces.discard();
        }
        this.telemetryConsent = "denied";
        const outbox = this.outboxInstance;
        void this.replay.withdraw();
        // In order: the session's end is announced (under the session lock, so only once the
        // lock is granted), the stored session is forgotten, what was collected with consent gets
        // one last attempt, and whatever is still unsent, in memory or stored, is deleted (PRV-4).
        void quiet(
          this.session
            .settled()
            .then(() => {
              this.session.sever();
              this.storage.forget();
              return wasGranted ? Promise.all([this.logs.flush(), this.traces.flush()]) : undefined;
            })
            .then(() => {
              this.logs.discard();
              this.traces.discard();
              return outbox?.clear();
            }),
        );
      }
    }
    if (typeof c.replay === "boolean") {
      const next: ConsentState = c.replay ? "granted" : "denied";
      if (next !== this.replayConsent) {
        this.replayConsent = next;
        if (c.replay) this.replay.evaluate();
        else void this.replay.withdraw();
      }
    }
    this.replay.evaluate();
  }

  async flush(): Promise<void> {
    await this.session.settled();
    this.reportDrops();
    await Promise.all([this.logs.flush(), this.traces.flush()]);
  }

  /** Removes every hook and stops every timer. Synchronous: nothing of the SDK runs on the page afterwards. */
  uninstall(): void {
    this.stopped = true;
    for (const off of this.cleanup.splice(0).reverse()) attempt(off);
    if (this.dropTimer !== null) this.clock.clearTimeout(this.dropTimer);
    this.dropTimer = null;
    this.drainer?.close();
    this.session.stop();
    this.releaseTab?.();
  }

  /** LIF-4: stop capture, remove hooks, end the session and the replay stream, flush within the deadline. */
  async shutdown(): Promise<void> {
    const deadline = this.cfg.transport.shutdownDeadlineMs;
    const work = (async () => {
      const closing = this.replay.close("stop", deadline);
      if (await this.lastTab()) this.session.end("shutdown");
      await this.session.settled();
      this.reportDrops();
      // Hooks go only now, so the last records above still pass through the emitter.
      this.uninstall();
      await Promise.all([this.logs.flush(), this.traces.flush(), closing]);
    })();
    await Promise.race([quiet(work), new Promise((resolve) => setTimeout(resolve, deadline))]);
    this.uninstall();
    this.logs.close();
    this.traces.close();
    await quiet(this.pipeline.close());
  }

  /** ERR-6: after too many internal errors the SDK says so once and turns itself off. */
  disable(): void {
    if (this.disabled || this.stopped) return;
    this.log.warn("too many internal errors, the SDK turned itself off");
    attempt(() => this.emitter.emit("ouo.sdk.disabled", { "ouo.sdk.internal_errors": guardedFailures() }, { internal: true, severity: "WARN" }));
    this.disabled = true;
    attempt(() => void this.replay.close("error", 0));
    attempt(() => void this.logs.flush());
    this.uninstall();
    this.logs.close();
    this.traces.close();
    void quiet(this.pipeline.close());
  }

  diagnostics(): Diagnostics {
    const dropped: Diagnostics["dropped"] = [];
    for (const [key, count] of this.drops.totals) {
      const [signal, reason] = key.split("\n") as [string, DropReason];
      dropped.push({ signal, reason, count });
    }
    return {
      state: this.disabled ? "disabled" : this.stopped ? "off" : "running",
      sessionId: this.sessionId(),
      internalErrors: guardedFailures(),
      dropped,
      sent: { logs: this.logs.stats.sent, spans: this.traces.stats.sent, requests: this.http.stats.requests, bytes: this.http.stats.bytes },
      replayRecording: this.replay.recording(),
      consent: { telemetry: this.telemetryConsent, replay: this.replayConsent },
    };
  }
}

/** A body the Logs API can carry: a string, number, boolean, or a JSON-safe object of bounded size. */
function safeBody(body: unknown): unknown {
  if (typeof body === "string") return truncate(body, 32 * 1024);
  if (typeof body === "number" || typeof body === "boolean") return body;
  try {
    const json = JSON.stringify(body);
    return json !== undefined && json.length <= 32 * 1024 ? (JSON.parse(json) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

let runtime: Runtime | undefined;
/** `init` was called and the SDK is waiting for a prerendered page to activate (LIF-10). */
let waiting: (() => void) | undefined;

const live = (): Runtime | undefined => (runtime && !runtime.stopped && !runtime.disabled ? runtime : undefined);

/** Runs a public API body: never throws into the app, whatever happens inside (API-1, ERR-1). */
function api<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    contain(err);
    return fallback;
  }
}

/**
 * Starts the SDK. Call once, as early as possible. Never throws: an unusable configuration makes
 * the SDK a no-op (CFG-1), a second call is ignored (LIF-1), and on the server or in a runtime
 * without a DOM nothing happens at all (LIF-9). Returns without waiting for storage or the
 * network (LIF-2).
 */
export function init(config: OuoConfig): void {
  api(() => {
    const debug = (config as { debug?: unknown } | null | undefined)?.debug === true;
    const log = debug ? createLogger(true) : silentLogger;
    if (runtime || waiting) {
      log.warn("init called twice; the second call is ignored");
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const cfg = resolveConfig(config, (key, problem) => log.warn(`config ${key}: ${problem}`));
    if (!cfg) return;
    if (!hasSecureRandom()) {
      log.warn("no secure random generator, the SDK is off");
      return;
    }
    const boot = (): void => {
      waiting = undefined;
      const rt = new Runtime(cfg);
      runtime = rt;
      configureGuard({ report: (err) => rt.log.warn("contained an internal error", err), threshold: cfg.selfDisableThreshold, onThreshold: () => rt.disable() });
      try {
        rt.start();
      } catch (err) {
        // A browser without something the SDK needs: remove what was installed and stay off.
        rt.log.warn("could not start, the SDK is off", err);
        rt.uninstall();
        runtime = undefined;
        configureGuard(undefined);
      }
    };
    // A prerendered page starts no session and sends nothing until it activates.
    if ((document as Document & { prerendering?: boolean }).prerendering === true) {
      const off = listen(document, "prerenderingchange", () => {
        off();
        if (waiting) boot();
      });
      waiting = off;
      return;
    }
    boot();
  }, undefined);
}

/** Stops capture, removes every hook, ends the session and flushes within `transport.shutdownDeadlineMs`. `init` may be called again afterwards. */
export function shutdown(): Promise<void> {
  return api(() => {
    if (waiting) {
      waiting();
      waiting = undefined;
    }
    const rt = runtime;
    if (!rt) return Promise.resolve();
    runtime = undefined;
    return quiet(rt.disabled ? undefined : rt.shutdown()).then(() => {
      // Not when `init` was called again meanwhile: the guard then belongs to the new instance.
      if (!runtime) configureGuard(undefined);
    });
  }, Promise.resolve());
}

/** Exports what is queued. Resolves when it is sent, or on the shutdown deadline. Never rejects. */
export function flush(): Promise<void> {
  return api(() => {
    const rt = live();
    if (!rt) return Promise.resolve();
    return Promise.race([quiet(rt.flush()), new Promise<void>((resolve) => setTimeout(resolve, rt.cfg.transport.shutdownDeadlineMs))]);
  }, Promise.resolve());
}

/** The current session id, or undefined when there is none. */
export function getSessionId(): string | undefined {
  return api(() => live()?.sessionId(), undefined);
}

/** Ends the current session and starts a new one. */
export function restartSession(): void {
  api(() => live()?.restartSession(), undefined);
}

/** Sets `enduser.id` on later records; `null` clears it. A different user starts a new session. */
export function setUser(id: string | null): void {
  api(() => {
    if (id === null) live()?.setUser(null);
    else if (typeof id === "string" && id.trim() !== "") live()?.setUser(truncate(id.trim(), 256));
  }, undefined);
}

/** Updates consent. Only the keys given change. */
export function setConsent(consent: Consent): void {
  api(() => {
    if (consent && typeof consent === "object") live()?.setConsent(consent);
  }, undefined);
}

/** Attributes for every later record. Replaces the previous set. Names starting with `session.` or `ouo.` are rejected. */
export function setGlobalAttributes(attributes: Attrs): void {
  api(() => live()?.setGlobalAttributes(attributes), undefined);
}

/** A custom event. Names starting with `session.` or `ouo.` are rejected and counted. */
export function recordEvent(name: string, attributes?: Attrs, body?: unknown): void {
  api(() => {
    if (typeof name === "string") live()?.recordEvent(name.trim(), attributes, body);
  }, undefined);
}

/** A handled error. Attributes may include `ouo.exception.fingerprint` and `ouo.exception.handled`. */
export function recordException(error: unknown, attributes?: Attrs): void {
  api(() => live()?.recordException(error, attributes), undefined);
}

/** Declares a soft navigation the SDK cannot see, or names the one it just saw (a route template). */
export function trackNavigation(name: string, options?: NavigationOptions): void {
  api(() => {
    if (typeof name === "string" && name !== "") live()?.trackNavigation(name, options && typeof options === "object" ? options : {});
  }, undefined);
}

const noopTracerProvider = new ProxyTracerProvider();
const noopLoggerProvider: LoggerProvider = { getLogger: () => createNoopLogger() };

/** The SDK's tracer provider: spans made with it get the session and view attributes and the same export. */
export function getTracerProvider(): TracerProvider {
  return api(() => live()?.pipeline.tracerProvider ?? noopTracerProvider, noopTracerProvider);
}

/** The SDK's logger provider: records emitted through it get the session and view attributes and the same export. */
export function getLoggerProvider(): LoggerProvider {
  return api(() => live()?.pipeline.loggerProvider ?? noopLoggerProvider, noopLoggerProvider);
}

export const replay = {
  /** Starts recording again after `stop()`, if this session is sampled for replay and consent allows. */
  start(): void {
    api(() => live()?.replayApi("start"), undefined);
  },
  /** Stops recording and ends the stream. */
  stop(): void {
    api(() => live()?.replayApi("stop"), undefined);
  },
  /** Sends a buffered replay from here on (a session that keeps a ring, `replay.bufferRate`). */
  capture(): void {
    api(() => live()?.replayApi("capture"), undefined);
  },
};

/** Counts for debugging and support. Never a payload. */
export function diagnostics(): Diagnostics {
  const off: Diagnostics = {
    state: runtime?.disabled ? "disabled" : "off",
    sessionId: undefined,
    internalErrors: guardedFailures(),
    dropped: [],
    sent: { logs: 0, spans: 0, requests: 0, bytes: 0 },
    replayRecording: false,
    consent: { telemetry: "pending", replay: "pending" },
  };
  return api(() => runtime?.diagnostics() ?? off, off);
}

/**
 * Not public API. `recordException` for the SDK's own framework entries (they may set `ouo.*`
 * attributes), and the fault-injection hook of the test suites (GR-CRASH-7).
 */
export const _internal = {
  recordException(error: unknown, attributes: Attrs | undefined, sdk: Attrs): void {
    api(() => live()?.recordException(error, attributes, sdk), undefined);
  },
  injectFault,
};
