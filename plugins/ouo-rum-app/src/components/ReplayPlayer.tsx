import React, { useEffect, useImperativeHandle, useRef, forwardRef, useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import type { RrwebEvent } from '../api/types';

/** Svelte component methods rrweb-player inherits; `svelte` types are not installed. */
interface SvelteHandle {
  $set: (props: Record<string, unknown>) => void;
  $destroy: () => void;
}

export interface ReplayHandle {
  /** Seek to an offset (ms from replay start) without changing play state. */
  goto: (offsetMs: number) => void;
  play: () => void;
  pause: () => void;
}

interface Props {
  events: RrwebEvent[];
  /** Called with the current replay offset in ms, throttled. */
  onTime?: (offsetMs: number) => void;
}

/** Thin React wrapper over rrweb-player (Svelte). The replayer renders into a sandboxed iframe. */
export const ReplayPlayer = forwardRef<ReplayHandle, Props>(function ReplayPlayer({ events, onTime }, ref) {
  const styles = useStyles2(getStyles);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<rrwebPlayer | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      goto: (offsetMs: number) => {
        const p = playerRef.current;
        if (!p) {
          return;
        }
        // goto(ms, play?) — keep the current play state.
        p.goto(Math.max(0, offsetMs));
        onTimeRef.current?.(Math.max(0, offsetMs));
      },
      play: () => playerRef.current?.play(),
      pause: () => playerRef.current?.pause(),
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || events.length < 2) {
      return;
    }
    host.innerHTML = '';
    const width = Math.max(320, Math.floor(host.clientWidth));
    const height = Math.round((width * 9) / 16);
    let player: rrwebPlayer;
    try {
      player = new rrwebPlayer({
        target: host,
        props: {
          // rrweb-player's typings use its own eventWithTime; rum-api hands us raw rrweb events.
          events: events as unknown as ConstructorParameters<typeof rrwebPlayer>[0]['props']['events'],
          width,
          height,
          autoPlay: false,
          showController: true,
          skipInactive: true,
          speedOption: [1, 2, 4, 8],
          // Replayer defaults keep the iframe sandbox="allow-same-origin" (no scripts); do not change.
          mouseTail: false,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    playerRef.current = player;
    setError(null);

    let last = 0;
    player.addEventListener('ui-update-current-time', (payload) => {
      const now = performance.now();
      if (now - last < 100) {
        return;
      }
      last = now;
      const p = payload as { payload?: number } | number;
      const ms = typeof p === 'number' ? p : (p?.payload ?? 0);
      onTimeRef.current?.(ms);
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
        // ignore teardown errors from the Svelte component
      }
      playerRef.current = null;
    };
  }, [events]);

  if (events.length < 2) {
    return <div className={styles.empty}>The replay has no renderable events yet.</div>;
  }

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>Replay failed to start: {error}</div>}
      <div ref={hostRef} className={styles.host} data-testid="replay-host" />
    </div>
  );
});

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ width: '100%' }),
  host: css({
    width: '100%',
    // rrweb-player's stylesheet floats .rr-player left, which collapses the host; contain it.
    display: 'flow-root',
    '.rr-player': { float: 'none', background: theme.colors.background.canvas, boxShadow: 'none', margin: '0 auto' },
    '.rr-controller': { background: theme.colors.background.secondary, color: theme.colors.text.primary },
    '.rr-player__frame': { background: theme.colors.background.canvas },
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
  error: css({ color: theme.colors.error.text, padding: theme.spacing(1) }),
});
