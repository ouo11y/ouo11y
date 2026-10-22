import React, { useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

interface Props {
  /** `exception.stacktrace` as recorded (one frame per line). */
  stack: string | undefined;
  /** Open on first render. */
  defaultOpen?: boolean;
}

/** Number of frames in a stack trace: its non-empty lines that look like frames. */
export function frameCount(stack: string): number {
  return stack.split('\n').filter((l) => /^\s*(at |\d+\s|[\w$.<>-]+@|#\d)/.test(l)).length;
}

/**
 * Expandable `exception.stacktrace` of an error (C1), used in the Timeline, the activity list and
 * the Logs panel. The toggle does not propagate the click, so it never seeks the replay.
 */
export function StackTrace({ stack, defaultOpen = false }: Props) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(defaultOpen);
  const text = stack?.trim();
  if (!text) {
    return null;
  }
  const frames = frameCount(text);
  return (
    <span className={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="stack-toggle"
      >
        <Icon name={open ? 'angle-down' : 'angle-right'} size="sm" />
        {open ? 'Hide' : 'Show'} stack trace{frames > 0 ? ` (${frames} frames)` : ''}
      </button>
      {open && (
        <pre className={styles.pre} data-testid="stack-trace">
          {text}
        </pre>
      )}
    </span>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ display: 'flex', flexDirection: 'column', minWidth: 0, cursor: 'auto' }),
  toggle: css({
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: theme.colors.text.link,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    '&:hover': { textDecoration: 'underline' },
  }),
  pre: css({
    margin: theme.spacing(0.5, 0, 0),
    padding: theme.spacing(1),
    maxHeight: 320,
    overflow: 'auto',
    whiteSpace: 'pre',
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.4,
    background: theme.colors.background.canvas,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
});
