import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, Icon, useStyles2 } from '@grafana/ui';
import { formatDateTime, formatRelative } from '../utils/format';
import type { FeedbackItem, FeedbackStep } from '../utils/feedback';
import { eventLook } from './Timeline';

interface Props {
  items: readonly FeedbackItem[];
  /** Origin of the times shown (epoch ms): the session start, the page's one clock. */
  clockStart: number;
  /** Seeks the replay beside the list to an epoch ms; absent without a replay. */
  onSeek?: (ts: number) => void;
}

/** Records whose step needs a word before it; the others' body is the whole step (`Tap pay (button) on Cart`, a log line). */
const STEP_TITLES: Record<string, string> = {
  'session.start': 'Session start',
  navigation: 'Navigation',
  exception: 'Error',
  'http.request': 'Request',
  'http.request.failed': 'Failed request',
  'ouo.app.start': 'App start',
  'ouo.screen.display': 'Screen displayed',
  'app.jank': 'Janky frames',
  'ouo.stall': 'JS stall',
  feedback: 'Feedback',
};

/** A step as the list reads it: a timeline event as the Timeline shows it, else the recorded step. */
export function stepText(step: FeedbackStep): { title: string; detail: string } {
  if (step.event) {
    const look = eventLook(step.event);
    return { title: look.title(step.event), detail: look.detail(step.event) };
  }
  const title = STEP_TITLES[step.name];
  return title ? { title, detail: step.body } : { title: step.body || step.name, detail: '' };
}

/**
 * The session's user feedback beside its replay (docs/specs/mobile-sdk.md C10): message, contact,
 * the steps before it, and a seek to the replay at the feedback time: the frame on screen then
 * (with `ouo.feedback.screenshot`, the SDK made sure replay was recording it).
 */
export function FeedbackList({ items, clockStart, onSeek }: Props) {
  const styles = useStyles2(getStyles);
  if (items.length === 0) {
    return null;
  }
  const at = (ts: number) => (Number.isFinite(clockStart) ? formatRelative(ts - clockStart) : formatDateTime(ts));
  return (
    <section className={styles.wrap} data-testid="feedback-list">
      <h5 className={styles.h5}>
        <Icon name="comment-alt-message" /> Feedback <span className={styles.muted}>({items.length})</span>
      </h5>
      {items.map((f) => (
        <article key={f.key} className={styles.item} data-testid="feedback-item">
          <div className={styles.head}>
            <span className={styles.muted} title={formatDateTime(f.ts)}>
              {at(f.ts)}
            </span>
            {f.contact && (
              <span data-testid="feedback-contact">
                <Icon name="user" /> {f.contact}
              </span>
            )}
            {f.screenshot && (
              <Badge
                text="replay recording"
                color="green"
                icon="lock"
                tooltip="Replay was recording when the feedback was sent: the replay at its time shows the screen, masked."
              />
            )}
            {onSeek && (
              <Button
                size="sm"
                variant="secondary"
                icon="play"
                className={styles.seek}
                onClick={() => onSeek(f.ts)}
                data-testid="feedback-seek"
              >
                Replay at feedback
              </Button>
            )}
          </div>
          <p className={styles.message} data-testid="feedback-message">
            {f.message}
          </p>
          {f.steps.length > 0 && (
            <details>
              <summary className={styles.muted}>Last {f.steps.length} events before it</summary>
              <ol className={styles.steps} data-testid="feedback-steps">
                {f.steps.map((s, i) => {
                  const t = stepText(s);
                  return (
                    <li key={i} data-testid="feedback-step">
                      <span className={styles.time}>{at(s.ts)}</span> <strong>{t.title}</strong>{' '}
                      {t.detail && <span className={styles.muted}>{t.detail}</span>}
                    </li>
                  );
                })}
              </ol>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({ marginTop: theme.spacing(1.5) }),
  h5: css({ margin: theme.spacing(0, 0, 1), fontSize: theme.typography.h5.fontSize }),
  item: css({
    border: `1px solid ${theme.colors.border.weak}`,
    borderLeft: `3px solid ${theme.colors.success.main}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1, 1.5),
    marginBottom: theme.spacing(1),
  }),
  head: css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing(1) }),
  seek: css({ marginLeft: 'auto' }),
  message: css({ margin: theme.spacing(0.75, 0), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
  muted: css({ color: theme.colors.text.secondary }),
  steps: css({
    margin: theme.spacing(0.5, 0, 0),
    paddingLeft: theme.spacing(2.5),
    fontSize: theme.typography.bodySmall.fontSize,
    overflowWrap: 'anywhere',
  }),
  time: css({ fontFamily: theme.typography.fontFamilyMonospace, color: theme.colors.text.secondary }),
});
