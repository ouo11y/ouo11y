import type { CSSProperties } from 'react';

/**
 * The kit's components take their colours from CSS custom properties, so a host restyles them by
 * setting these on any ancestor (the plugin maps Grafana's theme onto them). Fallbacks read on
 * light and dark backgrounds.
 */
export const themeVars = {
  border: 'var(--ouo-border, rgba(128, 128, 128, 0.25))',
  muted: 'var(--ouo-muted, rgba(128, 128, 128, 0.9))',
  hover: 'var(--ouo-hover, rgba(128, 128, 128, 0.12))',
  accent: 'var(--ouo-accent, #3d71d9)',
  danger: 'var(--ouo-danger, #d10e5c)',
  warning: 'var(--ouo-warning, #f5b73d)',
  track: 'var(--ouo-track, rgba(128, 128, 128, 0.15))',
} as const;

export type ThemeVar = keyof typeof themeVars;

/** Values for the custom properties, e.g. from a host theme: `<div style={themeStyle({...})}>`. */
export function themeStyle(values: Partial<Record<ThemeVar, string>>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v) {
      out[`--ouo-${k}`] = v;
    }
  }
  return out as CSSProperties;
}

export const cell: CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${themeVars.border}`, textAlign: 'left', verticalAlign: 'top' };
export const head: CSSProperties = { ...cell, color: themeVars.muted, fontWeight: 500 };
export const table: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
