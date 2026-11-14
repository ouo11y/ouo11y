import React, { useEffect, useRef, useState } from 'react';
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';

/** Svelte component methods rrweb-player inherits; `svelte` types are not installed. */
interface SvelteHandle {
  $set: (props: Record<string, unknown>) => void;
  $destroy: () => void;
}

export interface RrwebPlayerProps {
  /** rrweb events, in order. */
  events: unknown[];
  /** Called with the current offset in ms from the replay start, throttled to 10 Hz. */
  onTime?: (offsetMs: number) => void;
  className?: string;
}

/**
 * React wrapper over rrweb-player (Svelte), copied from the MVP plugin's ReplayPlayer without
 * its Grafana styling. The replayer renders into an iframe with sandbox="allow-same-origin"
 * (no scripts); do not change that.
 */
export function RrwebPlayer({ events, onTime, className }: RrwebPlayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || events.length < 2) {
      return;
    }
    host.innerHTML = '';
    const width = Math.max(320, Math.floor(host.clientWidth));
    let player: rrwebPlayer;
    try {
      player = new rrwebPlayer({
        target: host,
        props: {
          events: events as ConstructorParameters<typeof rrwebPlayer>[0]['props']['events'],
          width,
          height: Math.round((width * 9) / 16),
          autoPlay: false,
          showController: true,
          skipInactive: true,
          speedOption: [1, 2, 4, 8],
          mouseTail: false,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError(null);
    let last = 0;
    player.addEventListener('ui-update-current-time', (payload) => {
      const now = performance.now();
      if (now - last < 100) {
        return;
      }
      last = now;
      const p = payload as { payload?: number } | number;
      onTimeRef.current?.(typeof p === 'number' ? p : (p?.payload ?? 0));
    });
    const ro = new ResizeObserver(() => {
      const w = Math.max(320, Math.floor(host.clientWidth));
      if (Math.abs(w - width) < 8) {
        return;
      }
      (player as unknown as SvelteHandle).$set({ width: w, height: Math.round((w * 9) / 16) });
      player.triggerResize();
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      try {
        player.pause();
        (player as unknown as SvelteHandle).$destroy();
      } catch {
        // teardown errors from the Svelte component are not ours to report
      }
    };
  }, [events]);

  if (events.length < 2) {
    return <div className={className}>The recording has no renderable events yet.</div>;
  }
  return (
    <div className={className}>
      {error && <div role="alert">Replay failed to start: {error}</div>}
      {/* rrweb-player floats .rr-player left, which collapses the host; flow-root contains it. */}
      <div ref={hostRef} data-testid="ouo-replay-rrweb" style={{ width: '100%', display: 'flow-root' }} />
    </div>
  );
}
