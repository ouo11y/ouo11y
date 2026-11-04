import React from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';
import type { FunnelOutcome, FunnelStepResult } from '../api/types';
import { formatDuration } from '../utils/format';
import { stepLabel } from '../utils/funnel';

interface Props {
  steps: FunnelStepResult[];
  /** 1-based step whose drop-off list is open. */
  selected?: number;
  /** Called with the 1-based step (2..n) whose drop-off segment (or failed count: 'failed') was clicked. */
  onDropOff: (step: number, outcome?: FunnelOutcome) => void;
  /** Failure tracking is on: show the failed part of each drop-off. */
  showFailed?: boolean;
}

const CHART_HEIGHT = 220;

/**
 * Vertical funnel: one column per step. The solid bar is the sessions that reached the step (height
 * relative to step 1); the hatched segment above it is the sessions lost since the previous step,
 * clickable to list them, with its failed part (a failure event followed the previous step) solid at
 * its foot. Under each column: conversion, failed count and rate, median / p75 time from the previous
 * step.
 */
export function FunnelChart({ steps, selected, onDropOff, showFailed }: Props) {
  const styles = useStyles2(getStyles);
  const first = steps[0]?.sessions ?? 0;
  const h = (n: number) => (first > 0 ? Math.round((n / first) * CHART_HEIGHT) : 0);

  return (
    <div className={styles.chart} role="list" aria-label="Funnel">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].sessions : s.sessions;
        const stepNo = i + 1;
        return (
          <div key={`${s.label}-${i}`} className={styles.column} role="listitem">
            <div className={styles.bars} style={{ height: CHART_HEIGHT }}>
              {i > 0 && s.dropped_off > 0 && (
                <Tooltip
                  content={`${s.dropped_off} sessions reached step ${i} but not step ${stepNo}${
                    showFailed ? `, ${s.failed} of them after a failure` : ''
                  }: click to list them`}
                >
                  <button
                    type="button"
                    className={cx(styles.drop, selected === stepNo && styles.dropSelected)}
                    style={{ height: Math.max(h(prev) - h(s.sessions), 4) }}
                    onClick={() => onDropOff(stepNo)}
                    aria-label={`Show ${s.dropped_off} sessions dropped before step ${stepNo}`}
                  >
                    <span className={styles.dropText}>−{s.dropped_off}</span>
                    {showFailed && s.failed > 0 && (
                      <span
                        className={styles.failedPart}
                        style={{ height: `${Math.round((s.failed / s.dropped_off) * 100)}%` }}
                      />
                    )}
                  </button>
                </Tooltip>
              )}
              <div className={styles.bar} style={{ height: Math.max(h(s.sessions), s.sessions > 0 ? 2 : 0) }}>
                <span className={styles.barText}>{s.sessions}</span>
              </div>
            </div>
            <div className={styles.meta}>
              <div className={styles.label} title={s.label}>
                <Icon name={s.step.kind === 'page' ? 'file-alt' : 'bolt'} size="sm" /> {stepNo}. {stepLabel(s.step)}
              </div>
              <div className={styles.big}>{s.conversion_from_first.toFixed(1)}%</div>
              <div className={styles.small}>
                {s.sessions} sessions · {s.users} users
              </div>
              {i > 0 && (
                <>
                  <div className={styles.small}>{s.conversion_from_previous.toFixed(1)}% of previous step</div>
                  {showFailed && (
                    <div className={styles.small}>
                      {s.failed > 0 ? (
                        <button
                          type="button"
                          className={styles.failedLink}
                          onClick={() => onDropOff(stepNo, 'failed')}
                          aria-label={`Show ${s.failed} sessions failed before step ${stepNo}`}
                        >
                          <Icon name="exclamation-triangle" size="xs" /> {s.failed} failed
                        </button>
                      ) : (
                        '0 failed'
                      )}{' '}
                      · {s.failure_rate.toFixed(1)}% failure rate
                    </div>
                  )}
                  <div className={styles.small}>
                    <Icon name="clock-nine" size="xs" /> median {formatDuration(s.median_ms)} · p75{' '}
                    {formatDuration(s.p75_ms)}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  chart: css({
    display: 'flex',
    gap: theme.spacing(2),
    alignItems: 'flex-start',
    overflowX: 'auto',
    padding: theme.spacing(2, 0),
  }),
  column: css({ flex: '1 1 0', minWidth: 140, maxWidth: 260 }),
  bars: css({ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }),
  bar: css({
    background: theme.visualization.getColorByName('blue'),
    borderRadius: theme.shape.radius.default,
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
  }),
  barText: css({
    color: theme.colors.getContrastText(theme.visualization.getColorByName('blue')),
    fontWeight: 500,
    paddingTop: 2,
  }),
  drop: css({
    border: `1px dashed ${theme.colors.error.border}`,
    background: `repeating-linear-gradient(45deg, ${theme.colors.error.transparent}, ${theme.colors.error.transparent} 6px, transparent 6px, transparent 12px)`,
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    width: '100%',
    padding: 0,
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '&:hover': { background: theme.colors.error.transparent },
  }),
  dropSelected: css({ borderStyle: 'solid', borderWidth: 2, background: theme.colors.error.transparent }),
  dropText: css({ color: theme.colors.error.text, fontSize: theme.typography.bodySmall.fontSize, zIndex: 1 }),
  failedPart: css({
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    background: theme.colors.error.main,
    opacity: 0.45,
  }),
  failedLink: css({
    background: 'none',
    border: 'none',
    padding: 0,
    color: theme.colors.error.text,
    cursor: 'pointer',
    fontSize: 'inherit',
    '&:hover': { textDecoration: 'underline' },
  }),
  meta: css({ marginTop: theme.spacing(1) }),
  label: css({
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  big: css({ fontSize: theme.typography.h3.fontSize }),
  small: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
});
