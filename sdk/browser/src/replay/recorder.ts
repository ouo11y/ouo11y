import type { SessionManager, SessionRecord } from "../session/manager";
import type { DebugLogger } from "../logger";
import type { ReplayChunker } from "./chunker";

export interface RecorderOptions {
  enabled: boolean;
  maskAllInputs: boolean;
  sampleRate: number;
  session: SessionManager;
  chunker: ReplayChunker;
  logger: DebugLogger;
}

type StopFn = () => void;
type RecordFn = (options: Record<string, unknown>) => StopFn | undefined;
interface RrwebModule {
  record: RecordFn & { takeFullSnapshot?: (isCheckout?: boolean) => void };
}

/** Privacy classes (ADR-0003). */
export const BLOCK_CLASS = "ouo-block";
export const MASK_TEXT_CLASS = "ouo-mask";
/** Periodic full snapshots keep seeking cheap (ADR-0003). */
export const CHECKOUT_EVERY_MS = 5 * 60 * 1000;

/** Drives rrweb: lazy loading, sampling, pause/resume, and full snapshots on session rotation. */
export class ReplayRecorder {
  private rrweb: RrwebModule | null = null;
  private stopFn: StopFn | null = null;
  private loading: Promise<void> | null = null;
  private paused = false;

  constructor(private readonly opts: RecorderOptions) {}

  /** Loads rrweb (dynamic import, separate chunk) when replay is enabled and the session is sampled. */
  async start(): Promise<void> {
    if (!this.opts.enabled) {
      this.opts.logger.log("replay disabled");
      return;
    }
    if (!this.opts.session.replaySampled(this.opts.sampleRate)) {
      this.opts.logger.log("replay not sampled for this session");
      return;
    }
    if (this.paused) return;
    if (!this.rrweb) {
      if (!this.loading) {
        this.loading = import("rrweb").then((mod) => {
          this.rrweb = mod as unknown as RrwebModule;
        });
      }
      await this.loading;
    }
    this.record();
  }

  pause(): void {
    this.paused = true;
    if (this.stopFn) {
      this.stopFn();
      this.stopFn = null;
      this.opts.logger.log("replay paused");
    }
    void this.opts.chunker.flush();
  }

  resume(): void {
    this.paused = false;
    // A new record() call starts with a fresh full snapshot.
    void this.start();
  }

  isRecording(): boolean {
    return this.stopFn !== null;
  }

  /** Session rotated: flush what belongs to the old session, then snapshot for the new one. */
  onRotate(next: SessionRecord, previousId: string | undefined): void {
    void this.opts.chunker.flush();
    if (!this.opts.enabled || this.paused) return;
    const sampled = this.opts.session.replaySampled(this.opts.sampleRate);
    if (!sampled) {
      if (this.stopFn) {
        this.stopFn();
        this.stopFn = null;
      }
      this.opts.logger.log("replay: new session not sampled", next.id);
      return;
    }
    if (this.stopFn) {
      this.opts.logger.log("replay: full snapshot for new session", next.id, previousId ?? "");
      this.rrweb?.record.takeFullSnapshot?.(true);
    } else {
      void this.start();
    }
  }

  flush(keepalive: boolean): Promise<void> {
    return this.opts.chunker.flush({ keepalive });
  }

  private record(): void {
    if (this.stopFn || !this.rrweb || this.paused) return;
    const stop = this.rrweb.record({
      emit: (event: unknown) => this.opts.chunker.push(event),
      maskAllInputs: this.opts.maskAllInputs,
      blockClass: BLOCK_CLASS,
      maskTextClass: MASK_TEXT_CLASS,
      checkoutEveryNms: CHECKOUT_EVERY_MS,
      recordCanvas: false,
      collectFonts: false,
      inlineImages: false,
      slimDOMOptions: { script: true, comment: true },
      errorHandler: (err: unknown) => this.opts.logger.warn("rrweb error", err),
    });
    this.stopFn = stop ?? null;
    this.opts.logger.log("replay recording", this.stopFn ? "started" : "failed to start");
  }
}
