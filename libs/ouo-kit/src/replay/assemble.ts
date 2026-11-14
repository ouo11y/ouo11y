import type { ChunkEntry, StreamEntry } from '../manifest';

/**
 * The playable runs of a stream (Muninn spec RDR-3): chunks in sequence order, each run
 * starting at a keyframe and ending before the first missing sequence. After a gap, play
 * resumes at the next keyframe.
 */
export function playableRuns(stream: StreamEntry): ChunkEntry[][] {
  const chunks = [...(stream.chunks ?? [])].sort((a, b) => a.sequence - b.sequence);
  const runs: ChunkEntry[][] = [];
  let run: ChunkEntry[] | null = null;
  let prev = -2;
  for (const c of chunks) {
    const contiguous = c.sequence === prev + 1;
    prev = c.sequence;
    if (run && contiguous) {
      run.push(c);
      continue;
    }
    run = null;
    if (c.keyframe) {
      run = [c];
      runs.push(run);
    }
  }
  return runs;
}

/**
 * Parses the newline-delimited JSON of a structure format. A chunk may end in the middle of a
 * line, so the decompressed chunks of one run are concatenated before splitting. A line that is
 * not valid JSON (a run cut short) is skipped.
 */
export function parseNdjson<T = unknown>(parts: ArrayBuffer[]): T[] {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  const out: T[] = [];
  for (const line of new TextDecoder().decode(all).split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // the tail of a run that ends mid-line
    }
  }
  return out;
}

/** The stream to play first: the earliest with a playable run. */
export function primaryStream(streams: StreamEntry[]): StreamEntry | undefined {
  return [...streams].sort((a, b) => a.start_time - b.start_time).find((s) => playableRuns(s).length > 0);
}
