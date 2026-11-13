/**
 * The format seam of replay (SDK spec section 11.6, RPL-27). The engine owns the hierarchy
 * (replay, stream, segment, chunk), identity, bounds, delivery and end rules; an adapter owns
 * what is recorded and how it is encoded. The web SDK records one format:
 *
 * - `rrweb/2` (technique `structure/dom`): a description of the DOM, driven by a MutationObserver,
 *   as rrweb events, one JSON document per line. Text is replaced by `***`.
 *
 * `pixel.ts` holds a second adapter, `ouo.frames/1` (masked images of the viewport), that is under
 * development and paused: nothing selects it and it is not in the build.
 *
 * A format is a stream of self-delimiting units, so the concatenation of a segment's chunk bodies is
 * a valid payload of the format and a unit may be split across chunks (RPL-7, RPL-11).
 */
import type { DropReason } from "../core/drops";

export interface AdapterSink {
  /** One unit of the format. `keyframe`: a reader can start decoding here with no earlier data. */
  data(bytes: Uint8Array, o: { time: number; keyframe: boolean }): void;
  /** A frame or event was left out (masking failed, PRV-8). */
  dropped(reason: DropReason): void;
  /** The adapter cannot go on; the stream ends as partial. */
  failed(err: unknown): void;
}

export interface ReplayAdapter {
  /** `ouo.replay.format`. */
  readonly format: string;
  /** Whether chunk bodies are gzipped by the engine (`ouo.replay.encoding`: `gzip`, else `identity`). */
  readonly compress: boolean;
  /** Begins recording. The engine discards what comes before the first keyframe. */
  start(sink: AdapterSink): void;
  /** Produces a keyframe now (RPL-6, RPL-8, RPL-9). */
  requestKeyframe(): void;
  /** Stops recording and releases every listener, observer and timer. */
  stop(): void;
}

export interface AdapterOptions {
  sanitize(url: string): string;
}
