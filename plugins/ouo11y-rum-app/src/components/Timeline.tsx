import React, { useEffect, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2, type IconName } from '@grafana/data';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import type { TimelineEvent, VitalRating } from '../api/types';
import { formatDateTime, formatRelative, parseTs } from '../utils/format';
import { isVitalEvent, vitalDetail, vitalRating, vitalTitle } from '../utils/vitals';
import { scrollRowIntoView } from '../utils/scroll';
import { StackTrace } from './StackTrace';

interface Props {
  timeline: TimelineEvent[];
  /** Session start in ms: the session's one clock (times here, in the activity list and the players). */
  sessionStart: number;
  /** Index of the event to highlight (latest event at or before the replay cursor), -1 for none. */
  activeIndex: number;
  /** Called with the event's absolute timestamp (ms) when it is clicked. */
  onSeek?: (tsMs: number, event: TimelineEvent) => void;
  /**
   * Time (epoch ms) of the merged tap of a `ui.tap` event, by timeline index: the touch start, which is
   * what the activity list and the player show (the breadcrumb is written when the touch ends).
   */
  tapTimes?: ReadonlyMap<number, number>;
}

interface Look {
  icon: IconName;
  color: (theme: GrafanaTheme2) => string;
  title: (ev: TimelineEvent) => string;
  detail: (ev: TimelineEvent) => string;
}

const LOOKS: Record<string, Look> = {
  'session.start': {
    icon: 'play',
    color: (t) => t.colors.info.main,
    title: () => 'Session start',
    detail: () => '',
  },
  navigation: {
    icon: 'compass',
    color: (t) => t.colors.primary.main,
    title: (ev) => `Navigation ${ev.attrs.ouo_navigation_kind ? `(${ev.attrs.ouo_navigation_kind})` : ''}`.trim(),
    detail: (ev) => ev.attrs.url_path ?? ev.attrs.url_full ?? '',
  },
  exception: {
    icon: 'bug',
    color: (t) => t.colors.error.main,
    title: (ev) => (ev.attrs.ouo_exception_fatal === 'true' ? 'Fatal error' : 'Error'),
    detail: (ev) =>
      `${ev.attrs.exception_type ?? ''}${ev.attrs.exception_type ? ': ' : ''}${ev.attrs.exception_message ?? ''}`,
  },
  'http.request.failed': {
    icon: 'exclamation-triangle',
    color: (t) => t.colors.warning.main,
    title: (ev) => `Failed request ${ev.attrs.http_response_status_code ?? ''}`.trim(),
    detail: (ev) => `${ev.attrs.http_request_method ?? ''} ${ev.attrs.url_full ?? ev.attrs.url_path ?? ''}`.trim(),
  },
  web_vital: {
    icon: 'heart-rate',
    color: (t) => t.colors.text.secondary,
    title: (ev) => `Web vital ${ev.attrs.ouo_web_vital_name ?? ''}`.trim(),
    detail: (ev) => `${ev.attrs.ouo_web_vital_value ?? ''} (${ev.attrs.ouo_web_vital_rating ?? 'n/a'})`,
  },
  custom: {
    icon: 'bolt',
    color: (t) => t.colors.text.primary,
    title: (ev) => ev.name,
    detail: (ev) =>
      Object.entries(ev.attrs)
        .filter(([k]) => !k.startsWith('ouo_event') && k !== 'severity_text')
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  },
  'session.end': {
    icon: 'times-circle',
    color: (t) => t.colors.text.secondary,
    title: (ev) => `Session end${ev.attrs.ouo_session_end_reason ? ` (${ev.attrs.ouo_session_end_reason})` : ''}`,
    detail: () => '',
  },
};

// Custom events with a known name: what the Sentry bridge derives from Sentry logs, messages and the
// breadcrumbs of replay recordings (docs/specs/sentry-bridge.md sections 7a and 9a).
const levelColor = (level: string | undefined) => (t: GrafanaTheme2) => {
  switch (level) {
    case 'error':
    case 'fatal':
      return t.colors.error.main;
    case 'warn':
    case 'warning':
      return t.colors.warning.main;
    default:
      return t.colors.text.secondary;
  }
};

const NAMED: Record<string, (ev: TimelineEvent) => Look> = {
  log: (ev) => ({
    icon: 'gf-logs',
    color: levelColor(ev.attrs.ouo_sentry_level),
    title: (e) => `Log${e.attrs.ouo_sentry_level ? ` (${e.attrs.ouo_sentry_level})` : ''}`,
    detail: (e) => e.attrs.message ?? '',
  }),
  console: (ev) => ({
    icon: 'brackets-curly',
    color: levelColor(ev.attrs.ouo_sentry_level),
    title: () => 'Console',
    detail: (e) => e.attrs.message ?? '',
  }),
  'http.request': () => ({
    icon: 'exchange-alt',
    color: (t) => t.colors.text.secondary,
    title: (e) => `Request ${e.attrs.http_response_status_code ?? ''}`.trim(),
    detail: (e) => `${e.attrs.http_request_method ?? ''} ${e.attrs.url_full ?? ''}`.trim(),
  }),
  'app.lifecycle': () => ({
    icon: 'mobile-android',
    color: (t) => t.colors.text.secondary,
    title: (e) => `App ${e.attrs.ouo_app_state ?? ''}`.trim(),
    detail: () => '',
  }),
  'ui.tap': () => ({
    icon: 'arrow-right',
    color: (t) => t.colors.text.primary,
    title: () => 'Tap',
    detail: (e) => e.attrs.ouo_ui_target ?? '',
  }),
  breadcrumb: () => ({
    icon: 'list-ul',
    color: (t) => t.colors.text.secondary,
    title: (e) => e.attrs.ouo_breadcrumb_category ?? 'Breadcrumb',
    detail: (e) =>
      [
        e.attrs.message,
        ...Object.entries(e.attrs)
          .filter(([k]) => k.startsWith('ouo_breadcrumb_data_'))
          .map(([k, v]) => `${k.slice('ouo_breadcrumb_data_'.length)}=${v}`),
      ]
        .filter(Boolean)
        .join(' '),
  }),
  'sentry.message': () => ({
    icon: 'comment-alt',
    color: (t) => t.colors.text.primary,
    title: () => 'Message',
    detail: (e) => e.attrs.message ?? '',
  }),
};

/** Colour of a vital by its rating (mobile vitals spec section 4). */
export const ratingColor = (rating: VitalRating | undefined) => (t: GrafanaTheme2) => {
  switch (rating) {
    case 'good':
      return t.colors.success.main;
    case 'needs-improvement':
      return t.colors.warning.main;
    case 'poor':
      return t.colors.error.main;
    default:
      return t.colors.text.secondary;
  }
};

const VITAL_ICONS: Record<string, IconName> = {
  'ouo.app.start': 'arrow-up',
  'ouo.screen.display': 'mobile-android',
  'app.jank': 'tachometer-fast',
  'ouo.stall': 'clock-nine',
};

/** Mobile vitals (type `vital`; older rum-api versions type them `custom`). */
function vitalLook(ev: TimelineEvent): Look {
  return {
    icon: VITAL_ICONS[ev.name] ?? 'heart-rate',
    color: ratingColor(vitalRating(ev)),
    title: vitalTitle,
    detail: vitalDetail,
  };
}

const FALLBACK: Look = {
  icon: 'info-circle',
  color: (t) => t.colors.text.secondary,
  title: (ev) => ev.name,
  detail: () => '',
};

export function eventLook(ev: TimelineEvent): Look {
  if (isVitalEvent(ev)) {
    return vitalLook(ev);
  }
  const named = ev.type === 'custom' ? NAMED[ev.name] : undefined;
  if (named) {
    return named(ev);
  }
  const look = LOOKS[ev.type] ?? FALLBACK;
  if (ev.type === 'exception' && ev.attrs.ouo_exception_fatal !== 'true') {
    return { ...look, color: (t) => t.colors.warning.main };
  }
  return look;
}

export function Timeline({ timeline, sessionStart, activeIndex, onSeek, tapTimes }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const listRef = useRef<HTMLOListElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // Keep the highlighted event visible while a replay plays. Only the list scrolls (never the
  // page, which would move the pinned replay), and at most once per animation frame.
  useEffect(() => {
    const list = listRef.current;
    const item = activeRef.current;
    if (!list || !item) {
      return;
    }
    const frame = requestAnimationFrame(() => scrollRowIntoView(list, item));
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  if (!timeline.length) {
    return <div className={styles.empty}>No events recorded for this session.</div>;
  }

  return (
    <div className={styles.frame}>
      <ol ref={listRef} className={styles.list} data-testid="timeline">
        {timeline.map((ev, i) => {
          const look = eventLook(ev);
          const ts = tapTimes?.get(i) ?? parseTs(ev.ts);
          const active = i === activeIndex;
          const recorded = ev.clampedFrom ? parseTs(ev.clampedFrom) : NaN;
          return (
            <li
              key={`${ev.ts}-${i}`}
              ref={active ? activeRef : undefined}
              className={cx(styles.item, active && styles.active, onSeek && styles.clickable)}
              onClick={onSeek ? () => onSeek(ts, ev) : undefined}
              title={
                Number.isFinite(recorded)
                  ? `${formatDateTime(recorded)}, ${formatRelative(recorded - sessionStart)}: recorded before the session start`
                  : formatDateTime(ts)
              }
              data-active={active ? 'true' : undefined}
              data-clamped={ev.clampedFrom ? 'true' : undefined}
            >
              <span className={styles.time}>{Number.isNaN(ts) ? '' : formatRelative(ts - sessionStart)}</span>
              <span className={styles.icon} style={{ color: look.color(theme) }}>
                <Icon name={look.icon} />
              </span>
              <span className={styles.body}>
                <span className={styles.title}>{look.title(ev)}</span>
                {look.detail(ev) && <span className={styles.detail}>{look.detail(ev)}</span>}
                {ev.type === 'exception' && <StackTrace stack={ev.attrs.exception_stacktrace} />}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  // The list is the only scroll container of the Timeline panel. It is absolutely positioned in a
  // frame that fills the rest of the panel, so the timeline adds no height of its own: the grid row
  // takes the Replay panel's height and the list fills the Timeline panel to its bottom edge (a
  // max-height on the list left the panel's lower part empty when the Replay panel was taller).
  // Without a replay the frame keeps a usable height. Stacked (narrow) layouts have no row to
  // fill, so there the list is in the flow again, capped to the viewport.
  frame: css({
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 'min(480px, calc(100vh - 150px))',
    '@media (max-width: 899px)': { position: 'static', minHeight: 0 },
  }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    position: 'absolute',
    inset: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    '@media (max-width: 899px)': { position: 'relative', inset: 'auto', maxHeight: 'calc(100vh - 150px)' },
  }),
  item: css({
    display: 'grid',
    gridTemplateColumns: '72px 20px 1fr',
    gap: theme.spacing(1),
    alignItems: 'start',
    padding: theme.spacing(0.75, 1),
    borderLeft: '3px solid transparent',
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  clickable: css({ cursor: 'pointer', '&:hover': { background: theme.colors.action.hover } }),
  active: css({ background: theme.colors.action.selected, borderLeftColor: theme.colors.primary.main }),
  time: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    paddingTop: 2,
  }),
  icon: css({ paddingTop: 1 }),
  body: css({ display: 'flex', flexDirection: 'column', minWidth: 0 }),
  title: css({ fontWeight: theme.typography.fontWeightMedium }),
  detail: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    overflowWrap: 'anywhere',
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
