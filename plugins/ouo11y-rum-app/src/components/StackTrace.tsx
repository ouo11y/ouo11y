import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import type { Symbolicated, SymbolicatedFrame } from '../api/types';

interface Props {
  /** `exception.stacktrace` as recorded (one frame per line). */
  stack: string | undefined;
  /** rum-api's symbolication of the same stack (ADR-0011); absent without maps or on older rum-api. */
  symbolicated?: Symbolicated;
  /** Open on first render. */
  defaultOpen?: boolean;
}

/** Number of frames in a stack trace: its non-empty lines that look like frames. */
export function frameCount(stack: string): number {
  return stack.split('\n').filter((l) => /^\s*(at |\d+\s|[\w$.<>-]+@|#\d)/.test(l)).length;
}

/** A frame line of a JS stack, or of the Apple-style native crash stack ("0   App   0x104a1c2f0 ..."). */
const FRAME_LINE = /^\s*(at |[\w$.<>-]*@\S+:\d+:\d+|\d+\s+\S+\s+0x[0-9a-f]+)/i;

/** True when the symbolicated stack is worth showing: at least one frame mapped. */
function useful(s: Symbolicated | undefined): s is Symbolicated {
  return !!s && s.mapped > 0 && s.frames.length > 0;
}

/**
 * Expandable `exception.stacktrace` of an error (C1), used in the Timeline, the activity list and
 * the Logs panel. With source maps (ADR-0011) it opens on the original files, lines and functions,
 * with the source around the first mapped frame, and a toggle back to the raw minified stack. The
 * toggles do not propagate the click, so they never seek the replay. Source lines are rendered as
 * text (React escapes them), never as HTML.
 */
export function StackTrace({ stack, symbolicated, defaultOpen = false }: Props) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(defaultOpen);
  const [raw, setRaw] = useState(false);
  const text = stack?.trim();
  if (!text) {
    return null;
  }
  const frames = frameCount(text);
  const sym = useful(symbolicated) ? symbolicated : undefined;
  const native = sym?.frames.some((f) => f.address !== undefined) ?? false;
  const showOriginal = sym !== undefined && !raw;
  return (
    <span className={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <span className={styles.bar}>
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
        {sym && (
          <span
            className={styles.badge}
            data-testid="stack-symbolicated"
            title={native ? 'Symbolicated through the uploaded dSYMs' : 'Mapped through the uploaded source maps'}
          >
            {native ? 'symbolicated' : 'source mapped'}
            {sym.status === 'ok' ? '' : ` ${sym.mapped}/${sym.frames.length}`}
          </span>
        )}
        {open && sym && (
          <span role="group" aria-label="Stack view" className={styles.views}>
            <button
              type="button"
              className={cx(styles.view, showOriginal && styles.viewOn)}
              aria-pressed={showOriginal}
              onClick={() => setRaw(false)}
              data-testid="stack-view-original"
            >
              Original
            </button>
            <button
              type="button"
              className={cx(styles.view, !showOriginal && styles.viewOn)}
              aria-pressed={!showOriginal}
              onClick={() => setRaw(true)}
              data-testid="stack-view-raw"
            >
              Raw
            </button>
          </span>
        )}
      </span>
      {open &&
        (showOriginal ? (
          <OriginalStack sym={sym} />
        ) : (
          <pre className={styles.pre} data-testid="stack-trace">
            {text}
          </pre>
        ))}
    </span>
  );
}

function OriginalStack({ sym }: { sym: Symbolicated }) {
  const styles = useStyles2(getStyles);
  const top = sym.frames.find((f) => f.status === 'mapped' && f.context);
  const lines = sym.stacktrace.split('\n');
  const first = lines.findIndex((l) => FRAME_LINE.test(l));
  const header = (first < 0 ? lines : lines.slice(0, first)).filter((l) => l.trim());
  return (
    <div className={styles.pre} data-testid="stack-original">
      {header.length > 0 && <div className={styles.header}>{header.join('\n')}</div>}
      {sym.frames.map((f, i) => (
        <div key={i} className={cx(styles.frame, f.status !== 'mapped' && styles.dim)} data-testid="stack-frame">
          <FrameLine f={f} />
          {f === top && f.context && (
            <div className={styles.context} data-testid="stack-context">
              {f.context.pre.map((l, j) => (
                <div key={`p${j}`}>
                  <span className={styles.lineNo}>{f.original!.line - f.context!.pre.length + j}</span>
                  {l}
                </div>
              ))}
              <div className={styles.current}>
                <span className={styles.lineNo}>{f.original!.line}</span>
                {f.context.line}
              </div>
              {f.context.post.map((l, j) => (
                <div key={`n${j}`}>
                  <span className={styles.lineNo}>{f.original!.line + 1 + j}</span>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A native frame, atos style: `crash_here (crashy.c:8)`, or the binary and address without a dSYM. */
function NativeFrameLine({ f }: { f: SymbolicatedFrame }) {
  const o = f.original;
  const where = `${f.generated.file || '???'} ${f.address}`;
  if (!o) {
    return <span title={f.status === 'no_map' ? 'no dSYM uploaded for this binary' : 'no debug info at this address'}>{where}</span>;
  }
  const file = o.file ? ` (${o.file.slice(o.file.lastIndexOf('/') + 1)}${o.line ? `:${o.line}` : ''})` : '';
  return (
    <span title={`${where}${o.file ? `\n${o.file}` : ''}`}>
      {o.function || '???'}
      {file} in {f.generated.file}
      {f.inlined ? ' (inlined)' : ''}
    </span>
  );
}

function FrameLine({ f }: { f: SymbolicatedFrame }) {
  if (f.address !== undefined) {
    return <NativeFrameLine f={f} />;
  }
  const p = f.original ?? f.generated;
  return (
    <span
      title={
        f.original
          ? `${f.generated.file}:${f.generated.line}:${f.generated.column}`
          : f.status === 'no_map'
            ? 'no source map uploaded'
            : 'no mapping'
      }
    >
      at {p.function ? `${p.function} ` : ''}({p.file}:{p.line}:{p.column})
    </span>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ display: 'flex', flexDirection: 'column', minWidth: 0, cursor: 'auto' }),
  bar: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), flexWrap: 'wrap' }),
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
  badge: css({
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.success.text,
  }),
  views: css({
    display: 'inline-flex',
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
  }),
  view: css({
    padding: theme.spacing(0, 1),
    border: 'none',
    background: 'transparent',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
  }),
  viewOn: css({ background: theme.colors.action.selected, color: theme.colors.text.primary }),
  pre: css({
    margin: theme.spacing(0.5, 0, 0),
    padding: theme.spacing(1),
    maxHeight: 320,
    overflow: 'auto',
    whiteSpace: 'pre',
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.4,
    background: theme.colors.background.canvas,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  header: css({ marginBottom: theme.spacing(0.5) }),
  frame: css({ paddingLeft: theme.spacing(2) }),
  dim: css({ color: theme.colors.text.secondary }),
  context: css({
    margin: theme.spacing(0.5, 0, 0.5, 0),
    padding: theme.spacing(0.5, 0),
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
  }),
  current: css({ background: theme.colors.error.transparent, fontWeight: theme.typography.fontWeightMedium }),
  lineNo: css({
    display: 'inline-block',
    width: 40,
    paddingRight: theme.spacing(1),
    textAlign: 'right',
    color: theme.colors.text.disabled,
    userSelect: 'none',
  }),
});
