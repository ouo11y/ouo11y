import React, { useEffect, useMemo, useRef, useState } from 'react';
import { drawListAt, frameAt, segmentAt, splitFrames, touchesAt, type FrameEvent, type PatchEvent, type Touch, type VideoSegment } from './pixel';

/** A replay clock over [start, end] in epoch ms, advanced by animation frames while playing. */
function useClock(start: number, end: number) {
  const [t, setT] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing) {
      return;
    }
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const dt = (now - last) * speed;
      last = now;
      setT((v) => {
        const next = Math.min(end, v + dt);
        if (next >= end) {
          setPlaying(false);
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);
  return {
    t,
    playing,
    speed,
    seek: (v: number) => setT(Math.max(start, Math.min(end, v))),
    toggle: () => {
      if (!playing && t >= end) {
        setT(start);
      }
      setPlaying(!playing);
    },
    setSpeed,
  };
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Controls({ clock, start, end }: { clock: ReturnType<typeof useClock>; start: number; end: number }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
      <button type="button" onClick={clock.toggle} data-testid="ouo-replay-play">
        {clock.playing ? 'Pause' : 'Play'}
      </button>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(clock.t - start)}</span>
      <input
        type="range"
        aria-label="Replay position"
        min={start}
        max={end}
        value={clock.t}
        onChange={(e) => clock.seek(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(end - start)}</span>
      <select aria-label="Speed" value={clock.speed} onChange={(e) => clock.setSpeed(Number(e.target.value))}>
        {[1, 2, 4, 8].map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
    </div>
  );
}

const TOUCH_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 24,
  height: 24,
  marginLeft: -12,
  marginTop: -12,
  borderRadius: '50%',
  background: 'rgba(255, 64, 64, 0.45)',
  border: '2px solid rgba(255, 64, 64, 0.9)',
  pointerEvents: 'none',
};

/** Touch dots over a picture of `w` x `h` pixels; touch points are in points, times `scale`. */
function Touches({ touches, w, h, scale }: { touches: Touch[]; w: number; h: number; scale: number }) {
  return (
    <>
      {touches.map((x, i) => (
        <span
          key={`${x.t}-${i}`}
          data-testid="ouo-replay-touch"
          style={{ ...TOUCH_STYLE, left: `${((x.x * scale) / w) * 100}%`, top: `${((x.y * scale) / h) * 100}%` }}
        />
      ))}
    </>
  );
}

function loadImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('JPEG could not be decoded'));
    img.src = `data:image/jpeg;base64,${base64}`;
  });
}

/** Plays `ouo-frames/3`: JPEG full frames and patches on a canvas, touches over it. */
export function FramesPlayer({ events }: { events: unknown[] }) {
  const { images, touches } = useMemo(() => splitFrames(events), [events]);
  const start = images[0]?.t ?? 0;
  const end = Math.max(images[images.length - 1]?.t ?? 0, touches[touches.length - 1]?.t ?? 0) + 1000;
  const clock = useClock(start, end);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cache = useRef(new Map<string, Promise<HTMLImageElement>>());
  const list = drawListAt(images, clock.t);
  const base = frameAt(images, clock.t);
  const key = list.map((e) => e.t).join(',');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) {
      return;
    }
    let live = true;
    const img = (jpeg: string) => {
      let p = cache.current.get(jpeg);
      if (!p) {
        p = loadImage(jpeg);
        cache.current.set(jpeg, p);
      }
      return p;
    };
    const ops = list.flatMap((e: FrameEvent | PatchEvent) =>
      e.type === 'frame' ? [{ x: 0, y: 0, jpeg: e.jpeg }] : e.patches.map((p) => ({ x: p.x, y: p.y, jpeg: p.jpeg }))
    );
    Promise.all(ops.map((o) => img(o.jpeg))).then(
      (decoded) => {
        if (!live) {
          return;
        }
        canvas.width = base.w;
        canvas.height = base.h;
        const ctx = canvas.getContext('2d');
        decoded.forEach((im, i) => ctx?.drawImage(im, ops[i].x, ops[i].y));
        canvas.dataset.drawnT = String(list[list.length - 1].t);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
    // `key` names the draw list; `list` and `base` are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!base && images.length === 0) {
    return <div>The recording has no frame to show.</div>;
  }
  return (
    <div>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <canvas ref={canvasRef} data-testid="ouo-replay-frames" style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', background: '#000' }} />
        {base && <Touches touches={touchesAt(touches, clock.t)} w={base.w} h={base.h} scale={base.scale} />}
      </div>
      <Controls clock={clock} start={start} end={end} />
    </div>
  );
}

/** Plays `ouo-video/1`: one mp4 per segment in a `<video>`, the replay clock as master. */
export function VideoPlayer({ segments }: { segments: VideoSegment[] }) {
  const sorted = useMemo(() => [...segments].sort((a, b) => a.header.t - b.header.t), [segments]);
  const urls = useMemo(() => sorted.map((s) => URL.createObjectURL(new Blob([s.mp4 as BlobPart], { type: 'video/mp4' }))), [sorted]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const start = sorted[0]?.header.t ?? 0;
  const end = sorted[sorted.length - 1]?.header.end ?? 0;
  const clock = useClock(start, end);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pos = segmentAt(sorted, clock.t);
  const seg = sorted[pos.index];

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seg) {
      return;
    }
    if (v.dataset.segment !== String(pos.index)) {
      v.src = urls[pos.index];
      v.dataset.segment = String(pos.index);
    }
    // In a gap the last frame of the segment before stays on screen.
    const want = pos.inside ? (clock.t - seg.header.t) / 1000 : Math.max(0, (seg.header.end - seg.header.t) / 1000 - 0.05);
    if (Math.abs(v.currentTime - want) > 0.25 || !clock.playing) {
      try {
        v.currentTime = want;
      } catch {
        // not seekable before metadata; the next tick retries
      }
    }
    v.playbackRate = clock.speed;
    if (clock.playing && pos.inside) {
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [clock.t, clock.playing, clock.speed, pos.index, pos.inside, seg, urls]);

  if (!seg) {
    return <div>The recording has no video segment.</div>;
  }
  const h = seg.header;
  const touches = [...(h.touches ?? [])].sort((a, b) => a.t - b.t);
  return (
    <div>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <video ref={videoRef} data-testid="ouo-replay-video" muted playsInline style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', background: '#000' }} />
        <Touches touches={touchesAt(touches, clock.t)} w={h.w} h={h.h} scale={h.scale} />
      </div>
      <Controls clock={clock} start={start} end={end} />
    </div>
  );
}
