import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChunkEntry } from '../manifest';
import { locateSegment, parseVideoChunk, touchesAt, videoTimeline, type VideoHeader } from './video';

export interface VideoPlayerProps {
  /** The stream's `ouo-video/1` chunks; played in sequence order, a gap skipped. */
  chunks: ChunkEntry[];
  /** Returns one chunk's bytes (encoding `identity`: the body as sent). */
  fetchChunk: (sequence: number) => Promise<ArrayBuffer>;
  /**
   * Called with the current offset in ms from the first segment's start, on the wall clock (a
   * skipped gap counts), on every time update and seek.
   */
  onTime?: (offsetMs: number) => void;
  className?: string;
}

/** The speeds rrweb-player offers, so both renderers have the same choice. */
const SPEEDS = [1, 2, 4, 8];

type Segment = { url: string; header: VideoHeader } | { error: string };
type Shown = { seq: number; url: string; header: VideoHeader };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const clock = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Plays `ouo-video/1` segments back to back as one timeline (one mp4 per chunk, handed to a
 * `<video>` as an object URL) with the touches drawn over it. The segment on screen and the next
 * one are fetched; the others' object URLs are revoked. A chunk that cannot be fetched, parsed or
 * decoded is named in a line under the video and skipped.
 */
export function VideoPlayer({ chunks, fetchChunk, onTime, className }: VideoPlayerProps) {
  const { segments, total } = useMemo(() => videoTimeline(chunks), [chunks]);
  const fetchRef = useRef(fetchChunk);
  fetchRef.current = fetchChunk;
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cache = useRef(new Map<number, Promise<Segment>>());
  /** Where to start the segment that is loading, in ms into it. */
  const pendingSeek = useRef(0);
  /** The last segment played to its end: Play starts over. */
  const finished = useRef(false);

  const [index, setIndex] = useState(0);
  const [local, setLocal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [shown, setShown] = useState<Shown>();
  const [skipped, setSkipped] = useState<Array<{ seq: number; error: string }>>([]);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const active = segments[index];
  const report = useCallback(
    (i: number, ms: number) => {
      const s = segments[i];
      if (s) {
        onTimeRef.current?.(s.chunk.start_time + ms - segments[0].chunk.start_time);
      }
    },
    [segments],
  );

  const load = useCallback((seq: number): Promise<Segment> => {
    let p = cache.current.get(seq);
    if (!p) {
      p = Promise.resolve()
        .then(() => fetchRef.current(seq))
        .then((body) => {
          const { header, mp4 } = parseVideoChunk(body);
          return { url: URL.createObjectURL(new Blob([mp4 as BlobPart], { type: 'video/mp4' })), header };
        })
        .catch((err: unknown) => ({ error: message(err) }));
      cache.current.set(seq, p);
    }
    return p;
  }, []);

  /** Drops the cached segments other than `keep`, revoking their object URLs. */
  const evict = useCallback((keep: Set<number>) => {
    cache.current.forEach((p, seq) => {
      if (!keep.has(seq)) {
        cache.current.delete(seq);
        void p.then((s) => 'url' in s && URL.revokeObjectURL(s.url));
      }
    });
  }, []);
  useEffect(() => () => evict(new Set()), [evict]);

  const indexRef = useRef(index);
  indexRef.current = index;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Names a bad chunk and, when it is the one under the cursor, moves on to the next segment. */
  const skip = useCallback(
    (seq: number, error: string) => {
      setSkipped((list) => (list.some((s) => s.seq === seq) ? list : [...list, { seq, error }]));
      const i = indexRef.current;
      if (segments[i]?.chunk.sequence !== seq) {
        return;
      }
      if (i + 1 < segments.length) {
        pendingSeek.current = 0;
        setLocal(0);
        setIndex(i + 1);
      } else {
        setPlaying(false);
      }
    },
    [segments],
  );

  const start = useCallback((el: HTMLVideoElement) => {
    // A new source resets the rate to the default one.
    el.defaultPlaybackRate = speedRef.current;
    el.playbackRate = speedRef.current;
    if (playingRef.current) {
      el.play().catch(() => setPlaying(false));
    }
  }, []);

  // The segment under the cursor and the next one are fetched; the rest are let go.
  useEffect(() => {
    if (!active) {
      return;
    }
    let live = true;
    const seq = active.chunk.sequence;
    const next = segments[index + 1]?.chunk.sequence;
    // The segment on screen stays until the new one replaces it.
    const keep = new Set([seq]);
    if (next !== undefined) {
      keep.add(next);
    }
    if (shownRef.current) {
      keep.add(shownRef.current.seq);
    }
    evict(keep);
    void load(seq).then((s) => {
      if (!live) {
        return;
      }
      if ('error' in s) {
        skip(seq, s.error);
        return;
      }
      const el = videoRef.current;
      if (el && shownRef.current?.url === s.url) {
        // Back to the segment still on screen: same source, so no loadedmetadata to seek in.
        el.currentTime = pendingSeek.current / 1000;
        pendingSeek.current = 0;
        start(el);
      }
      setShown({ seq, url: s.url, header: s.header });
    });
    if (next !== undefined) {
      void load(next);
    }
    return () => {
      live = false;
    };
  }, [active, index, segments, load, evict, skip, start]);

  // Play, pause and speed reach the element here; segment changes go through onLoadedMetadata.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !shown) {
      return;
    }
    el.playbackRate = speed;
    if (playing) {
      el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }, [playing, speed, shown]);

  const seek = (offsetMs: number) => {
    const at = locateSegment(segments, offsetMs);
    if (at.index < 0) {
      return;
    }
    finished.current = false;
    setLocal(at.local);
    report(at.index, at.local);
    const el = videoRef.current;
    if (at.index === index && el && shown?.seq === active?.chunk.sequence) {
      el.currentTime = at.local / 1000;
      return;
    }
    el?.pause(); // the old segment stays on screen, still, while the new one loads
    pendingSeek.current = at.local;
    setIndex(at.index);
  };

  const toggle = () => {
    if (!playing && finished.current) {
      seek(0); // play again from the start
    }
    setPlaying(!playing);
  };

  if (!segments.length) {
    return <div className={className}>The recording has no video segments yet.</div>;
  }

  const current = shown && shown.seq === active?.chunk.sequence ? shown : undefined;
  const header = shown?.header;
  const ratio = header && header.w > 0 && header.h > 0 ? header.w / header.h : 9 / 19.5;
  const marks = current ? touchesAt(current.header, local) : [];
  const activeSkipped = skipped.find((s) => s.seq === active?.chunk.sequence);
  const offset = (active?.offset ?? 0) + Math.min(local, active?.duration ?? 0);

  return (
    <div className={className} data-testid="ouo-replay-video">
      <div
        style={{
          position: 'relative',
          margin: '0 auto',
          aspectRatio: `${ratio}`,
          width: `min(100%, calc(70vh * ${ratio}))`,
          background: '#000',
          overflow: 'hidden',
        }}
      >
        {shown && (
          <video
            ref={videoRef}
            src={shown.url}
            data-seq={shown.seq}
            data-testid="ouo-replay-video-element"
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            // The stage has the video's aspect ratio; fill maps the touch points one to one.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }}
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = pendingSeek.current / 1000;
              pendingSeek.current = 0;
              start(e.currentTarget);
            }}
            onTimeUpdate={(e) => {
              if (shown.seq !== active?.chunk.sequence) {
                return; // the previous segment, still on screen while the next one loads
              }
              const ms = e.currentTarget.currentTime * 1000;
              setLocal(ms);
              report(index, ms);
            }}
            onEnded={() => {
              if (index + 1 < segments.length) {
                pendingSeek.current = 0;
                setLocal(0);
                setIndex(index + 1);
              } else {
                finished.current = true;
                setPlaying(false);
              }
            }}
            onError={(e) => {
              const err = e.currentTarget.error;
              skip(shown.seq, err?.message || `media error ${err?.code ?? ''}`.trim());
            }}
          />
        )}
        {current && (
          <svg
            viewBox={`0 0 ${current.header.w} ${current.header.h}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            aria-hidden
          >
            {marks.map((p, i) => (
              <circle
                key={`${p.t}-${i}`}
                data-testid="ouo-replay-touch"
                cx={p.x * current.header.scale}
                cy={p.y * current.header.scale}
                r={Math.max(current.header.w, current.header.h) / 40}
                fill="rgba(255, 64, 64, 0.5)"
                stroke="#fff"
                strokeWidth={Math.max(1, current.header.w / 200)}
              />
            ))}
          </svg>
        )}
        {!current && (
          <div style={{ position: 'absolute', right: 8, bottom: 8, color: '#ccc', fontSize: 12 }}>
            {activeSkipped ? `Segment ${activeSkipped.seq} skipped` : `Loading segment ${active?.chunk.sequence}…`}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={Math.round(offset)}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          aria-label="Replay position"
          style={{ flex: 1, minWidth: 0 }}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {clock(offset)} / {clock(total)}
        </span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))} aria-label="Speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
        segment {index + 1}/{segments.length} (seq {active?.chunk.sequence})
      </div>
      {skipped.map((s) => (
        <div key={s.seq} role="status" style={{ fontSize: 12 }}>
          Segment {s.seq} skipped: {s.error}.
        </div>
      ))}
    </div>
  );
}
