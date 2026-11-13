import React, { useEffect, useMemo, useState } from 'react';
import type { ChunkFetcher, Manifest, StreamEntry } from '../api';
import { parseNdjson, playableRuns, primaryStream } from './assemble';
import { formatInfo } from './formats';
import { RrwebPlayer } from './RrwebPlayer';

export interface ReplayPlayerProps {
  manifest: Manifest;
  /** Returns one chunk's decompressed bytes. */
  fetchChunk: ChunkFetcher;
  onTime?: (offsetMs: number) => void;
  className?: string;
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'unplayable'; message: string }
  | { state: 'ready'; events: unknown[] };

/**
 * Plays one replay from its manifest: picks a stream, assembles its playable runs, fetches the
 * chunks and hands them to the renderer chosen by the chunks' format id. Several streams (two
 * tabs) get a stream picker.
 */
export function ReplayPlayer({ manifest, fetchChunk, onTime, className }: ReplayPlayerProps) {
  const streams = useMemo(() => manifest.streams ?? [], [manifest]);
  const [streamId, setStreamId] = useState<string | undefined>(() => primaryStream(streams)?.stream_id);
  const stream = streams.find((s) => s.stream_id === streamId);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const set = (l: Loaded) => !cancelled && setLoaded(l);
    if (!stream) {
      set({ state: 'unplayable', message: 'This replay has no chunk to start from (no keyframe held).' });
      return;
    }
    const runs = playableRuns(stream);
    const format = runs[0]?.[0]?.format ?? stream.chunks?.[0]?.format ?? '';
    const info = formatInfo(format);
    if (!info.renderer) {
      set({ state: 'unplayable', message: `Stored, not playable here: ${info.reason}.` });
      return;
    }
    set({ state: 'loading' });
    loadStructure(stream, runs.flat().map((c) => c.sequence), fetchChunk)
      .then((events) => set({ state: 'ready', events }))
      .catch((err: unknown) => set({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [stream, fetchChunk]);

  return (
    <div className={className} data-testid="ouo-replay">
      {streams.length > 1 && (
        <label>
          Stream{' '}
          <select value={streamId} onChange={(e) => setStreamId(e.target.value)}>
            {streams.map((s, i) => (
              <option key={s.stream_id} value={s.stream_id}>
                {i + 1}: {new Date(s.start_time).toLocaleTimeString()} ({s.state}, {s.chunks?.length ?? 0} chunks)
              </option>
            ))}
          </select>
        </label>
      )}
      {loaded.state === 'loading' && <div>Loading replay…</div>}
      {loaded.state === 'error' && <div role="alert">Replay failed to load: {loaded.message}</div>}
      {loaded.state === 'unplayable' && <div>{loaded.message}</div>}
      {loaded.state === 'ready' && <RrwebPlayer events={loaded.events} onTime={onTime} />}
    </div>
  );
}

/** Fetches the chunks of the stream's runs, a few at a time, and parses them per run. */
async function loadStructure(stream: StreamEntry, sequences: number[], fetchChunk: ChunkFetcher): Promise<unknown[]> {
  const bodies = new Map<number, ArrayBuffer>();
  const queue = [...sequences];
  const worker = async () => {
    for (let seq = queue.shift(); seq !== undefined; seq = queue.shift()) {
      bodies.set(seq, await fetchChunk(stream.stream_id, seq));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  const events: unknown[] = [];
  for (const run of playableRuns(stream)) {
    events.push(...parseNdjson(run.map((c) => bodies.get(c.sequence)!)));
  }
  return events;
}
