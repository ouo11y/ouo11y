import { attempt, guard } from "../guard";
import type { SessionManager, SessionRecord } from "../session/manager";
import type { DebugLogger } from "../logger";
import type { ReplayChunker } from "./chunker";
import { TabLease } from "./tabs";

export interface RecorderOptions {
  enabled: boolean;
  maskAllInputs: boolean;
  sampleRate: number;
  /** Fraction of the sessions without a full replay that buffer one and upload it after an error. */
  onErrorSampleRate: number;
  session: SessionManager;
  chunker: ReplayChunker;
  logger: DebugLogger;
  /** Elements matching this CSS selector are recorded as an empty box of the same size (rrweb `blockSelector`). */
  blockSelector?: string | undefined;
  /** Text inside elements matching this CSS selector is masked (rrweb `maskTextSelector`). */
  maskTextSelector?: string | undefined;
  /** Cross-tab coordination; injectable for tests. Default a BroadcastChannel lease. */
  lease?: TabLease;
}

type StopFn = () => void;
type RecordFn = (options: Record<string, unknown>) => StopFn | undefined;
interface RrwebModule {
  record: RecordFn & {
    takeFullSnapshot?: (isCheckout?: boolean) => void;
    addCustomEvent?: (tag: string, payload: unknown) => void;
  };
}

/** Privacy classes (ADR-0003). */
export const BLOCK_CLASS = "ouo-block";
export const MASK_TEXT_CLASS = "ouo-mask";
/** Periodic full snapshots keep seeking cheap (ADR-0003). */
export const CHECKOUT_EVERY_MS = 5 * 60 * 1000;
/** In buffer mode a full snapshot every 30 s; the buffer keeps the last two, 30 to 60 s of replay. */
export const BUFFER_CHECKOUT_EVERY_MS = 30 * 1000;
/** rrweb custom event marking the tab a stretch of replay was recorded in. */
export const TAB_EVENT_TAG = "ouo.tab";

export type ReplayMode = "off" | "buffer" | "full";

/**
 * Drives rrweb: lazy loading, sampling, pause/resume, full snapshots on session rotation,
 * error-triggered replay and multi-tab coordination.
 *
 * Modes, decided per session: `full` (sampled by `sampleRate`, or triggered by an error) uploads
 * chunks; `buffer` (sampled by `onErrorSampleRate`) keeps the last 30 to 60 s in memory and
 * switches to `full` on the first error, uploading the buffer first; `off` records nothing.
 *
 * Multi-tab: tabs of one browser share the session, and two rrweb streams in one session's
 * chunk sequence would interleave two DOMs. Only the tab that holds the lease records: the
 * visible tab the user last focused or touched. It claims the lease over a BroadcastChannel and
 * starts with a full snapshot; the tab that loses it, or is hidden, stops and flushes. The
 * replay is the sequence of what the user looked at, one tab after the other.
 */
export class ReplayRecorder {
  private rrweb: RrwebModule | null = null;
  private stopFn: StopFn | null = null;
  private loading: Promise<void> | null = null;
  /** rrweb could not be loaded (chunk blocked by CSP, offline, an ad blocker): replay stays off. */
  private unavailable = false;
  private paused = false;
  private mode: ReplayMode = "off";
  private ring: unknown[] = [];
  private checkouts: number[] = [];
  private readonly lease: TabLease;
  private uninstallTabs: (() => void) | null = null;

  constructor(private readonly opts: RecorderOptions) {
    this.lease = opts.lease ?? new TabLease();
  }

  /** Loads rrweb (dynamic import, separate chunk) when replay is enabled and the session is sampled. */
  async start(): Promise<void> {
    if (!this.opts.enabled) {
      this.opts.logger.log("replay disabled");
      return;
    }
    this.mode = this.decideMode();
    if (this.mode === "off") {
      this.opts.logger.log("replay not sampled for this session");
      return;
    }
    if (this.mode === "buffer") this.opts.logger.log("replay buffering until an error");
    if (!this.uninstallTabs) this.uninstallTabs = this.installTabs();
    if (this.paused) return;
    if (!this.rrweb) {
      if (this.unavailable) return;
      if (!this.loading) {
        // Never rejects: a failed chunk load must not become an unhandledrejection on the page.
        this.loading = import("rrweb").then(
          (mod) => {
            this.rrweb = mod as unknown as RrwebModule;
          },
          (err: unknown) => {
            this.unavailable = true;
            this.opts.logger.warn("replay: rrweb could not be loaded, replay is off for this page", err);
          },
        );
      }
      await this.loading;
      if (!this.rrweb) return;
    }
    if (this.isActiveTab()) {
      this.lease.claim(this.opts.session.id());
      this.record();
    }
  }

  pause(): void {
    this.paused = true;
    this.stop("replay paused");
  }

  resume(): void {
    this.paused = false;
    // A new record() call starts with a fresh full snapshot.
    void this.start();
  }

  isRecording(): boolean {
    return this.stopFn !== null;
  }

  currentMode(): ReplayMode {
    return this.mode;
  }

  /**
   * An error was reported. A buffering session switches to `full` for good (persisted, so other
   * tabs and reloads upload too): the buffer goes to the chunker, then recording restarts in
   * full mode with a fresh snapshot.
   */
  onError(): void {
    if (this.mode !== "buffer") return;
    this.opts.session.triggerReplay();
    this.mode = "full";
    const buffered = this.ring;
    this.ring = [];
    this.checkouts = [];
    this.opts.logger.log("replay: error, uploading the buffer", `${buffered.length} events`);
    const wasRecording = this.stopFn !== null;
    if (this.stopFn) {
      attempt(this.stopFn);
      this.stopFn = null;
    }
    for (const e of buffered) this.opts.chunker.push(e);
    void this.opts.chunker.flush();
    if (wasRecording) this.record();
  }

  /** Session rotated: flush what belongs to the old session, then snapshot for the new one. */
  onRotate(next: SessionRecord, previousId: string | undefined): void {
    void this.opts.chunker.flush();
    this.ring = [];
    this.checkouts = [];
    if (!this.opts.enabled || this.paused) return;
    const mode = this.decideMode();
    const changed = mode !== this.mode;
    this.mode = mode;
    if (mode === "off") {
      this.stop("replay: new session not sampled " + next.id);
      return;
    }
    if (this.stopFn && !changed) {
      this.opts.logger.log("replay: full snapshot for new session", next.id, previousId ?? "");
      attempt(() => this.rrweb?.record.takeFullSnapshot?.(true));
      return;
    }
    // Checkout interval and target differ per mode: restart.
    if (this.stopFn) {
      attempt(this.stopFn);
      this.stopFn = null;
    }
    void this.start();
  }

  flush(keepalive: boolean): Promise<void> {
    return this.opts.chunker.flush({ keepalive });
  }

  /** Stops recording and listening (SDK uninstall). */
  shutdown(): void {
    this.stop("replay stopped");
    this.uninstallTabs?.();
    this.uninstallTabs = null;
    this.lease.close();
  }

  // ---- internals ----

  private decideMode(): ReplayMode {
    const s = this.opts.session;
    if (!s.sampled()) return "off";
    if (s.replaySampled(this.opts.sampleRate) || s.replayTriggered()) return "full";
    return this.opts.onErrorSampleRate > 0 && s.replayOnError(this.opts.onErrorSampleRate) ? "buffer" : "off";
  }

  private isActiveTab(): boolean {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  private stop(reason: string): void {
    if (this.stopFn) {
      const stop = this.stopFn;
      this.stopFn = null;
      attempt(stop);
      this.opts.logger.log(reason);
    }
    if (this.mode === "full") void this.opts.chunker.flush();
  }

  /** Visibility, focus and input claim the lease; another tab's claim or hiding stops recording. */
  private installTabs(): () => void {
    const claim = guard((): void => {
      if (this.paused || this.mode === "off" || !this.isActiveTab()) return;
      if (this.stopFn && this.lease.isOwner()) return;
      this.lease.claim(this.opts.session.id());
      if (!this.stopFn) this.record();
    });
    const onVisibility = guard((): void => {
      if (document.visibilityState === "hidden") this.stop("replay: tab hidden");
      else claim();
    });
    const offLost = this.lease.onLost(
      guard((sessionId: string) => {
        if (sessionId !== this.opts.session.peek()?.id) return;
        this.stop("replay: another tab took over");
      }),
    );
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("visibilitychange", onVisibility);
    globalThis.addEventListener("focus", claim);
    globalThis.addEventListener("pointerdown", claim, opts);
    globalThis.addEventListener("keydown", claim, opts);
    return () => {
      offLost();
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("focus", claim);
      globalThis.removeEventListener("pointerdown", claim, opts);
      globalThis.removeEventListener("keydown", claim, opts);
    };
  }

  private emit(event: unknown, isCheckout?: boolean): void {
    if (this.mode === "full") {
      this.opts.chunker.push(event);
      return;
    }
    // Buffer: keep from the second-to-last full snapshot on. A checkout is a Meta event (type 4)
    // followed by a FullSnapshot, both emitted with isCheckout; the Meta one marks the cut.
    if (isCheckout && (event as { type?: number }).type === 4) {
      this.checkouts.push(this.ring.length);
      if (this.checkouts.length > 2) {
        const cut = this.checkouts[this.checkouts.length - 2]!;
        this.ring = this.ring.slice(cut);
        this.checkouts = this.checkouts.slice(-2).map((i) => i - cut);
      }
    } else if (this.ring.length === 0) {
      this.checkouts = [0];
    }
    this.ring.push(event);
  }

  private record(): void {
    if (this.stopFn || !this.rrweb || this.paused || this.mode === "off") return;
    const rrweb = this.rrweb;
    // rrweb guards its own observers with errorHandler; record() itself (the first full snapshot)
    // and our emit callback are guarded here.
    const stop = attempt(() =>
      rrweb.record({
        emit: guard((event: unknown, isCheckout?: boolean) => this.emit(event, isCheckout)),
        maskAllInputs: this.opts.maskAllInputs,
        blockClass: BLOCK_CLASS,
        maskTextClass: MASK_TEXT_CLASS,
        ...(this.opts.blockSelector ? { blockSelector: this.opts.blockSelector } : {}),
        ...(this.opts.maskTextSelector ? { maskTextSelector: this.opts.maskTextSelector } : {}),
        checkoutEveryNms: this.mode === "buffer" ? BUFFER_CHECKOUT_EVERY_MS : CHECKOUT_EVERY_MS,
        recordCanvas: false,
        collectFonts: false,
        inlineImages: false,
        slimDOMOptions: { script: true, comment: true },
        errorHandler: (err: unknown) => {
          this.opts.logger.warn("rrweb error", err);
          // Handled: rrweb does not rethrow into the page.
          return true;
        },
      }),
    );
    this.stopFn = stop ?? null;
    if (this.stopFn) attempt(() => rrweb.record.addCustomEvent?.(TAB_EVENT_TAG, { tab_id: this.lease.tabId, url: location.href }));
    this.opts.logger.log(`replay recording (${this.mode})`, this.stopFn ? "started" : "failed to start");
  }
}
