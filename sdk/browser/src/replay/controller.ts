/**
 * The part of replay that lives in the core bundle: it decides whether this session records
 * (replay sampling from the second 8 hex characters of the session id, consent: SMP-8,
 * SMP-9, RPL-19, PRV-3), loads the engine and the format adapter on demand, and passes the page
 * lifecycle on. Everything heavy is in the lazy chunks.
 */
import type { AnyValue } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { Config } from "../config";
import type { Clock } from "../core/clock";
import type { DropCounter } from "../core/drops";
import { fractionAt, randomHex } from "../core/ids";
import { attempt, point, quiet } from "../guard";
import type { DebugLogger } from "../logger";
import type { SessionRecord } from "../session/manager";
import type { KeyValueStorage } from "../session/storage";
import type { Http } from "../transport/http";
import type { Outbox } from "../transport/store";
import type { EndReason, ReplayEngine, Trigger } from "./engine";

const REPLAY_KEY = "ouo.replay";
/** Set while this origin may have replay chunks in the outbox, so a later page loads the engine to send them. */
const PENDING_KEY = "ouo.replay.pending";

export interface ControllerDeps {
  cfg: Config;
  clock: Clock;
  drops: DropCounter;
  log: DebugLogger;
  storage: KeyValueStorage;
  makeRecord(name: string, attributes: Record<string, AnyValue>, time: number, observed: number, body?: Uint8Array): ReadableLogRecord | undefined;
  http: Http;
  /** Null while nothing may be stored. */
  outbox(): Outbox | null;
  session(): SessionRecord | null;
  viewId(): string | undefined;
  sanitize(url: string): string;
  /** Replay consent is granted (or not required). */
  consented(): boolean;
}

export class ReplayController {
  private engine: ReplayEngine | undefined;
  private starting: Promise<void> | undefined;
  /** `replay.stop()` was called: nothing records until `replay.start()`. */
  private stopped = false;
  private closed = false;
  private generation = 0;
  private recovering = false;

  constructor(private readonly d: ControllerDeps) {}

  /**
   * Whether the current session records, and how. One number decides, the second 8 hex characters
   * of the session id as a fraction (SMP-8): below `sessionRate` the whole session is recorded;
   * in the next `bufferRate` of the range a ring is kept and sent after a trigger; otherwise nothing.
   */
  private wanted(): { mode: "session" | "buffer"; session: SessionRecord } | null {
    const { enabled, sessionRate, bufferRate } = this.d.cfg.replay;
    if (!enabled || this.stopped || this.closed || !this.d.consented()) return null;
    const session = this.d.session();
    if (!session || !session.s) return null;
    const at = fractionAt(session.id, 8);
    if (at < sessionRate) return { mode: "session", session };
    return at < sessionRate + bufferRate ? { mode: "buffer", session } : null;
  }

  /** Brings recording in line with the session, consent and API state. Safe to call at any time. */
  evaluate(): void {
    const want = this.wanted();
    const eng = this.engine;
    if (eng && (!want || eng.sessionId !== want.session.id)) {
      this.engine = undefined;
      this.generation++;
      // Consent withdrawal does not come through here: `withdraw()` discards the stream without
      // an end record, because nothing more may be emitted (PRV-4).
      void quiet(eng.end(!want && this.stopped ? "stop" : "session_end"));
    }
    if (want && !this.engine && !this.starting) {
      const generation = ++this.generation;
      this.starting = quiet(this.begin(want.mode, want.session, generation)).finally(() => {
        this.starting = undefined;
        // The session may have changed while the chunk was loading.
        if (generation !== this.generation && !this.closed) this.evaluate();
      });
    }
  }

  private replayId(session: string, fresh: boolean): string {
    const stored = attempt(() => JSON.parse(this.d.storage.get(REPLAY_KEY) ?? "null") as { s?: string; r?: string } | null, null);
    if (!fresh && stored?.s === session && typeof stored.r === "string" && /^[0-9a-f]{32}$/.test(stored.r)) return stored.r;
    const id = randomHex(16);
    attempt(() => this.d.storage.set(REPLAY_KEY, JSON.stringify({ s: session, r: id })));
    return id;
  }

  private async begin(mode: "session" | "buffer", session: SessionRecord, generation: number): Promise<void> {
    point("replay.load");
    const { cfg } = this.d;
    const mod = await import("./engine");
    const adapter = (await import("./structure")).createStructureAdapter({ sanitize: this.d.sanitize });
    if (generation !== this.generation || this.closed) return;
    const engine = new mod.ReplayEngine({
      adapter,
      mode,
      replayId: this.replayId(session.id, this.fresh),
      sessionId: session.id,
      viewId: this.d.viewId,
      makeRecord: this.d.makeRecord,
      http: this.d.http,
      logsUrl: cfg.logsUrl,
      outbox: this.d.outbox(),
      drops: this.d.drops,
      log: this.d.log,
      clock: this.d.clock,
      settings: {
        chunkMaxBytes: cfg.replay.chunkMaxBytes,
        chunkMaxMs: cfg.replay.chunkMaxMs,
        keyframeIntervalMs: cfg.replay.keyframeIntervalMs,
        bufferSeconds: cfg.replay.bufferSeconds,
        retryInitialMs: cfg.transport.retryInitialMs,
        retryMaxMs: cfg.transport.retryMaxMs,
        ttlMs: cfg.transport.persistTtlMs,
      },
      onEnded: () => {
        if (this.engine === engine) this.engine = undefined;
      },
    });
    this.fresh = false;
    this.engine = engine;
    if (mode === "session") this.markPending();
    engine.start();
  }

  /** The next replay gets a new id (after `replay.stop()` then `replay.start()`). */
  private fresh = false;

  private markPending(): void {
    if (this.d.outbox()) attempt(() => this.d.storage.set(PENDING_KEY, "1"));
  }

  // ---- public API ----

  start(): void {
    if (this.stopped) this.fresh = true;
    this.stopped = false;
    this.evaluate();
  }

  stop(): void {
    this.stopped = true;
    this.evaluate();
  }

  /** `replay.capture()` or a bypass-set record: a buffered replay is sent from here on. */
  trigger(kind: Trigger): void {
    if (!this.engine) return;
    this.markPending();
    this.engine.trigger(kind);
  }

  recording(): boolean {
    return this.engine !== undefined;
  }

  // ---- lifecycle ----

  onHidden(): void {
    attempt(() => this.engine?.onHidden());
  }

  onVisible(): void {
    attempt(() => this.engine?.onVisible());
  }

  /** Page hide, before telemetry is flushed: the chunk is closed and the stream ended. */
  onPageHide(): ReplayEngine | undefined {
    const eng = this.engine;
    this.engine = undefined;
    this.generation++;
    attempt(() => eng?.onPageHide());
    return eng;
  }

  /** Consent was withdrawn: stop and delete what was not sent (PRV-4). */
  async withdraw(): Promise<void> {
    const eng = this.engine;
    this.engine = undefined;
    this.generation++;
    if (eng) await quiet(eng.discard());
    else await quiet(this.d.outbox()?.clear("replay"));
    attempt(() => {
      this.d.storage.remove(REPLAY_KEY);
      this.d.storage.remove(PENDING_KEY);
    });
  }

  /** Loads the engine only when an earlier page may have left chunks behind, and sends them. */
  recover(): void {
    const outbox = this.d.outbox();
    if (!outbox || this.recovering || this.closed) return;
    if (attempt(() => this.d.storage.get(PENDING_KEY), null) !== "1") return;
    this.recovering = true;
    void quiet(
      (async () => {
        const mod = await import("./engine");
        const clean = await mod.recoverStreams({
          outbox,
          http: this.d.http,
          logsUrl: this.d.cfg.logsUrl,
          makeRecord: this.d.makeRecord,
          drops: this.d.drops,
          clock: this.d.clock,
          ttlMs: this.d.cfg.transport.persistTtlMs,
          own: new Set(this.engine ? [this.engine.streamId] : []),
        });
        if (clean && !this.engine) attempt(() => this.d.storage.remove(PENDING_KEY));
      })(),
    ).finally(() => {
      this.recovering = false;
    });
  }

  async close(reason: EndReason, deadlineMs: number): Promise<void> {
    this.closed = true;
    const eng = this.engine;
    this.engine = undefined;
    this.generation++;
    if (!eng) return;
    await Promise.race([quiet(eng.end(reason)), new Promise((r) => setTimeout(r, deadlineMs))]);
  }
}
