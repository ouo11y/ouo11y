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
   * skipped gap counts), on every seek and at most every 100 ms while playing.
   */
  onTime?: (offsetMs: number) => void;
  className?: string;
}

/** The speeds rrweb-player offers, so both renderers have the same choice. */
const SPEEDS = [1, 2, 4, 8];
/** The longest step the clock takes at once (a frame after the tab was hidden, say). */
const MAX_STEP_MS = 250;

type Segment = { url: string; header: VideoHeader } | { error: string };
type Shown = { seq: number; url: string; header: VideoHeader };
type Cursor = { index: number; local: number };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const clock = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Plays `ouo-video/1` segments back to back as one timeline, with the touches drawn over it.
 * The player keeps the time itself (a frame clock at the picked speed) and the `<video>` stays
 * paused: it shows the frame under the cursor, one seek per frame. A segment holds a single
 * keyframe at 1 frame/s, which `<video>` playback renders badly (Safari shows only keyframes
 * above 2x, and late frames after a seek); seeking a paused element lands on the exact frame in
 * every engine, and the touches follow the same clock at any speed. The segment on screen and
 * the next one are fetched (one mp4 each, an object URL); the others' URLs are revoked. A chunk
 * that cannot be fetched, parsed or decoded is named in a line under the video and skipped.
 */
export function VideoPlayer({ chunks, fetchChunk, onTime, className }: VideoPlayerProps) {
  const { segments, total } = useMemo(() => videoTimeline(chunks), [chunks]);
  const fetchRef = useRef(fetchChunk);
  fetchRef.current = fetchChunk;
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cache = useRef(new Map<number, Promise<Segment>>());
  /** The last segment played to its end: Play starts over. */
  const finished = useRef(false);

  const [cursor, setCursor] = useState<Cursor>({ index: 0, local: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [shown, setShown] = useState<Shown>();
  /** The object URL whose metadata the element has loaded: its frames can be shown. */
  const [loaded, setLoaded] = useState<string>();
  const [skipped, setSkipped] = useState<Array<{ seq: number; error: string }>>([]);
  /** The page's Content Security Policy refused a segment's object URL. */
  const [blocked, setBlocked] = useState(false);

  const { index, local } = cursor;
  const active = segments[index];
  const current = shown && shown.seq === active?.chunk.sequence ? shown : undefined;
  const ready = !!current && loaded === current.url;

  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const report = useCallback(
    (c: Cursor) => {
      const s = segments[c.index];
      if (s) {
        onTimeRef.current?.(s.chunk.start_time + c.local - segments[0].chunk.start_time);
      }
    },
    [segments],
  );

  /** Moves the cursor; a move to another segment waits for that segment before the clock runs on. */
  const move = useCallback((c: Cursor) => {
    if (c.index !== cursorRef.current.index) {
      readyRef.current = false;
    }
    cursorRef.current = c;
    setCursor(c);
  }, []);

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

  /** Names a bad chunk and, when it is the one under the cursor, moves on to the next segment. */
  const skip = useCallback(
    (seq: number, error: string) => {
      setSkipped((list) => (list.some((s) => s.seq === seq) ? list : [...list, { seq, error }]));
      const i = cursorRef.current.index;
      if (segments[i]?.chunk.sequence !== seq) {
        return;
      }
      if (i + 1 < segments.length) {
        move({ index: i + 1, local: 0 });
      } else {
        finished.current = true;
        setPlaying(false);
      }
    },
    [segments, move],
  );

  // Without `media-src blob:` every segment fails with a bare media error; say why instead
  // (Grafana's own CSP template, when switched on, has `media-src 'none'`).
  useEffect(() => {
    const onViolation = (e: Event) => {
      const v = e as SecurityPolicyViolationEvent;
      if (v.effectiveDirective === 'media-src' && String(v.blockedURI).startsWith('blob')) {
        setBlocked(true);
      }
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
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
      setShown((old) => (old?.url === s.url ? old : { seq, url: s.url, header: s.header }));
    });
    if (next !== undefined) {
      void load(next);
    }
    return () => {
      live = false;
    };
  }, [active, index, segments, load, evict, skip]);

  // The clock: while playing, the cursor moves at the picked speed through the segments.
  useEffect(() => {
    if (!playing) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    let reported = 0;
    const tick = (now: number) => {
      const step = Math.min(MAX_STEP_MS, Math.max(0, now - last)) * speedRef.current;
      last = now;
      const { index: i, local: at } = cursorRef.current;
      const s = segments[i];
      if (s && readyRef.current) {
        let c: Cursor = { index: i, local: at + step };
        if (c.local >= s.duration) {
          if (i + 1 < segments.length) {
            c = { index: i + 1, local: 0 };
          } else {
            c = { index: i, local: s.duration };
            finished.current = true;
            setPlaying(false);
          }
        }
        move(c);
        if (c.index !== i || now - reported >= 100 || finished.current) {
          reported = now;
          report(c);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, segments, move, report]);

  // The element shows the frame under the cursor: a seek when the frame changes.
  const frameShown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !current || !ready) {
      return;
    }
    const frame = `${current.url}#${Math.floor((local * current.header.fps) / 1000)}`;
    if (frameShown.current !== frame) {
      frameShown.current = frame;
      el.currentTime = local / 1000;
    }
  }, [current, ready, local]);

  const seek = (offsetMs: number) => {
    const at = locateSegment(segments, offsetMs);
    if (at.index < 0) {
      return;
    }
    finished.current = false;
    const c = { index: at.index, local: at.local };
    move(c);
    report(c);
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
            onLoadedMetadata={() => {
              frameShown.current = undefined;
              setLoaded(shown.url);
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
      {blocked && (
        <div role="alert" style={{ fontSize: 12 }}>
          This page's Content Security Policy blocks the video: its media-src must allow blob: (in Grafana,
          content_security_policy_template).
        </div>
      )}
      {skipped.map((s) => (
        <div key={s.seq} role="status" style={{ fontSize: 12 }}>
          Segment {s.seq} skipped: {s.error}.
        </div>
      ))}
    </div>
  );
}
