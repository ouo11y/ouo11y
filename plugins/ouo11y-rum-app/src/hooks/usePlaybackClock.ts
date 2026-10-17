import { useCallback, useEffect, useRef, useState } from 'react';
import { clampOffset } from '../utils/frames';

export type PlaybackSpeed = 1 | 2;

/** Throttle for `onTime` while the clock advances (same cadence as the rrweb wrapper). */
export const REPORT_EVERY_MS = 100;

/** Longest the clock waits for `hold` (e.g. a video segment still loading) before running on. */
export const MAX_HOLD_MS = 4000;

interface Options {
  /** Replay length in ms; the clock runs over `[0, durationMs]`. */
  durationMs: number;
  /** Called with the offset, throttled while playing, immediately on seeks. */
  onTime?: (offsetMs: number) => void;
  /**
   * Asked on every animation frame while playing; `true` keeps the clock still (up to
   * `MAX_HOLD_MS` in a row), e.g. while the video segment under the cursor is still loading.
   */
  hold?: (offsetMs: number) => boolean;
  /** Called after every offset change (tick or seek) so media elements can follow the clock. */
  onAdvance?: (offsetMs: number) => void;
}

/**
 * Replay clock shared by the frame and video players: a `requestAnimationFrame` loop that advances
 * the offset by wall time × speed, plus the `goto`/`play`/`pause` actions the `ReplayHandle` exposes.
 */
export function usePlaybackClock({ durationMs, onTime, hold, onAdvance }: Options) {
  const [offsetMs, setOffsetMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const offsetRef = useRef(0);
  const lastReportRef = useRef(0);
  const onTimeRef = useRef(onTime);
  const holdRef = useRef(hold);
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onTimeRef.current = onTime;
    holdRef.current = hold;
    onAdvanceRef.current = onAdvance;
  });

  const goto = useCallback(
    (ms: number) => {
      const next = clampOffset(ms, durationMs);
      offsetRef.current = next;
      setOffsetMs(next);
      lastReportRef.current = performance.now();
      onTimeRef.current?.(next);
      onAdvanceRef.current?.(next);
    },
    [durationMs]
  );

  const play = useCallback(() => {
    if (durationMs <= 0) {
      return;
    }
    if (offsetRef.current >= durationMs) {
      goto(0);
    }
    setPlaying(true);
  }, [durationMs, goto]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    let heldMs = 0;
    const tick = (now: number) => {
      const elapsed = now - last;
      last = now;
      if (!holdRef.current?.(offsetRef.current)) {
        heldMs = 0;
      } else if (heldMs < MAX_HOLD_MS) {
        heldMs += elapsed;
        raf = requestAnimationFrame(tick);
        return;
      }
      const next = Math.min(durationMs, offsetRef.current + elapsed * speed);
      offsetRef.current = next;
      setOffsetMs(next);
      onAdvanceRef.current?.(next);
      if (now - lastReportRef.current >= REPORT_EVERY_MS || next >= durationMs) {
        lastReportRef.current = now;
        onTimeRef.current?.(next);
      }
      if (next >= durationMs) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationMs]);

  return { offsetMs, offsetRef, playing, speed, setSpeed, goto, play, pause, toggle };
}
