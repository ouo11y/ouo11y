import React, { useEffect, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2, type IconName } from '@grafana/data';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import type { TimelineEvent } from '../api/types';
import { formatDateTime, formatRelative, parseTs } from '../utils/format';
import { scrollRowIntoView } from '../utils/scroll';

interface Props {
  timeline: TimelineEvent[];
  /** Session start in ms; relative times are computed from it. */
  sessionStart: number;
  /** Index of the event to highlight (latest event at or before the replay cursor), -1 for none. */
  activeIndex: number;
  /** Called with the event's absolute timestamp (ms) when it is clicked. */
  onSeek?: (tsMs: number, event: TimelineEvent) => void;
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

const FALLBACK: Look = {
  icon: 'info-circle',
  color: (t) => t.colors.text.secondary,
  title: (ev) => ev.name,
  detail: () => '',
};

export function eventLook(ev: TimelineEvent): Look {
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

export function Timeline({ timeline, sessionStart, activeIndex, onSeek }: Props) {
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
    <ol ref={listRef} className={styles.list} data-testid="timeline">
      {timeline.map((ev, i) => {
        const look = eventLook(ev);
        const ts = parseTs(ev.ts);
        const active = i === activeIndex;
        return (
          <li
            key={`${ev.ts}-${i}`}
            ref={active ? activeRef : undefined}
            className={cx(styles.item, active && styles.active, onSeek && styles.clickable)}
            onClick={onSeek ? () => onSeek(ts, ev) : undefined}
            title={formatDateTime(ts)}
            data-active={active ? 'true' : undefined}
          >
            <span className={styles.time}>{Number.isNaN(ts) ? '' : formatRelative(ts - sessionStart)}</span>
            <span className={styles.icon} style={{ color: look.color(theme) }}>
              <Icon name={look.icon} />
            </span>
            <span className={styles.body}>
              <span className={styles.title}>{look.title(ev)}</span>
              {look.detail(ev) && <span className={styles.detail}>{look.detail(ev)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  // The list is the only scroll container of the Timeline panel: it is capped to the viewport so a
  // long session scrolls here instead of pushing the pinned Replay panel off screen, and it grows
  // to fill the panel when the panel is stretched to the Replay panel's height.
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 160,
    maxHeight: 'calc(100vh - 150px)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
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
