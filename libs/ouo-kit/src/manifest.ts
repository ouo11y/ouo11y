// A replay as Muninn describes it (docs/specs/muninn.md section 7). These are Muninn's own
// answers, also what ouo-go's Muninn reader returns; a backend that serves them under paths of
// its own passes them on unchanged (chunk `path` may be left out).

/** One entry of a session's replay list (Muninn spec 7.1). */
export interface ReplaySummary {
  replay_id: string;
  state: 'open' | 'complete' | 'partial';
  start_time: number;
  end_time: number;
  chunk_count: number;
  byte_size: number;
  formats: string[];
  stream_count: number;
}

/** One chunk's entry in a manifest. */
export interface ChunkEntry {
  sequence: number;
  segment_index: number;
  keyframe: boolean;
  start_time: number;
  end_time: number;
  /** `ouo.replay.format`, e.g. `rrweb/2`. */
  format: string;
  encoding: string;
  byte_size: number;
  sha256: string;
  received_at: number;
  /** Every stored chunk attribute without a field of its own; may carry identity. */
  attributes: Record<string, unknown> | null;
}

/** One stream (a tab, a recording) of a replay. */
export interface StreamEntry {
  stream_id: string;
  state: string;
  start_time: number;
  end_time: number;
  missing: Array<[number, number]> | null;
  chunks: ChunkEntry[] | null;
}

/** One replay's manifest (Muninn spec 7.2). */
export interface Manifest {
  session_id: string;
  replay_id: string;
  project: string;
  state: string;
  start_time: number;
  end_time: number;
  chunk_count: number;
  byte_size: number;
  streams: StreamEntry[] | null;
}

/**
 * Returns one chunk's bytes, decompressed. The caller decides where they come from (its own
 * backend, Muninn through a proxy) and how the request is authorised.
 */
export type ChunkFetcher = (streamId: string, sequence: number) => Promise<ArrayBuffer>;
