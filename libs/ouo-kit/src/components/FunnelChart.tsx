import React from 'react';
import type { FunnelReport, FunnelStepResult, Outcome } from '../api';
import { formatDuration } from '../format';
import { themeVars } from './theme';

export interface FunnelChartProps {
  report: FunnelReport;
  /** A click on a step's drop-off (1-based step, outcome or undefined for both). */
  onDropOff?: (step: number, outcome?: Outcome) => void;
  /** The drop-off currently shown, highlighted. */
  selected?: { step: number; outcome?: Outcome };
}

const pct = (v: number) => `${v.toFixed(v % 1 === 0 ? 0 : 1)} %`;

/**
 * One horizontal bar per step: sessions that reached it, as a share of step 1, with the
 * platforms split and, from step 2, the drop-off (failed in the danger colour, abandoned in the
 * warning colour). Drop-offs are buttons when `onDropOff` is set.
 */
export function FunnelChart({ report, onDropOff, selected }: FunnelChartProps) {
  const first = report.steps[0]?.sessions ?? 0;
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }} data-testid="funnel-chart">
      {report.steps.map((s, i) => (
        <li key={i} data-testid="funnel-step">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong>
              {i + 1}. {s.step.label ?? s.step.value}
            </strong>
            <span>
              <span data-testid="funnel-sessions">{s.sessions}</span> sessions · {pct(s.conversion_from_first)} of step 1
              {i > 0 && ` · ${pct(s.conversion_from_previous)} of step ${i}`}
              {s.median_ms !== null && ` · median ${formatDuration(s.median_ms)}`}
            </span>
          </div>
          <Bar row={s} first={first} />
          {i > 0 && s.dropped_off > 0 && (
            <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: '0.9em' }}>
              <DropButton
                label={`${s.dropped_off} dropped`}
                onClick={onDropOff && (() => onDropOff(i + 1))}
                active={selected?.step === i + 1 && !selected.outcome}
              />
              {s.failed > 0 && (
                <DropButton
                  label={`${s.failed} failed (${pct(s.failure_rate)})`}
                  color={themeVars.danger}
                  testid="funnel-failed"
                  onClick={onDropOff && (() => onDropOff(i + 1, 'failed'))}
                  active={selected?.step === i + 1 && selected.outcome === 'failed'}
                />
              )}
              {s.dropped_off - s.failed > 0 && (
                <DropButton
                  label={`${s.dropped_off - s.failed} abandoned`}
                  color={themeVars.warning}
                  onClick={onDropOff && (() => onDropOff(i + 1, 'abandoned'))}
                  active={selected?.step === i + 1 && selected.outcome === 'abandoned'}
                />
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function Bar({ row, first }: { row: FunnelStepResult; first: number }) {
  const platforms = Object.entries(row.by_platform).sort(([a], [b]) => a.localeCompare(b));
  const shades = [themeVars.accent, 'color-mix(in srgb, var(--ouo-accent, #3d71d9) 60%, white)', 'color-mix(in srgb, var(--ouo-accent, #3d71d9) 60%, black)'];
  return (
    <div style={{ display: 'flex', height: 22, background: themeVars.track, borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
      {platforms.map(([p, n], j) => (
        <div
          key={p}
          title={`${p}: ${n}`}
          style={{ width: `${first ? (n / first) * 100 : 0}%`, background: shades[j % shades.length], color: '#fff', fontSize: 11, paddingLeft: 4, overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: '22px' }}
        >
          {p} {n}
        </div>
      ))}
    </div>
  );
}

function DropButton({ label, color, onClick, active, testid }: { label: string; color?: string; onClick?: () => void; active?: boolean; testid?: string }) {
  const style = { color: color ?? themeVars.muted, background: 'none', border: 'none', padding: 0, cursor: onClick ? 'pointer' : 'default', textDecoration: active ? 'underline' : undefined, font: 'inherit' };
  return onClick ? (
    <button type="button" style={style} onClick={onClick} data-testid={testid ?? 'funnel-dropped'}>
      {label}
    </button>
  ) : (
    <span style={style}>{label}</span>
  );
}
