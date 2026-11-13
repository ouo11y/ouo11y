/** Local date and time of ms since the epoch. */
export const formatTime = (ms: number) => new Date(ms).toLocaleString();

/** 42s, 3m 5s, 2h 10m. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 1.2 s, 340 ms, 0.08 (no unit), 12.5 %. */
export function formatValue(v: number, unit: string): string {
  if (unit === 'ms') {
    return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  }
  if (unit === '%') {
    return `${v.toFixed(1)} %`;
  }
  return unit ? `${v} ${unit}` : String(Math.round(v * 1000) / 1000);
}
