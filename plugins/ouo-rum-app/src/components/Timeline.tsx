import React, { useEffect, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2, type IconName } from '@grafana/data';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import type { TimelineEvent } from '../api/types';
import { formatDateTime, formatRelative, parseTs } from '../utils/format';

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

const FALLBACK: Look = {
  icon: 'info-circle',
  color: (t) => t.colors.text.secondary,
  title: (ev) => ev.name,
  detail: () => '',
};

export function eventLook(ev: TimelineEvent): Look {
  const look = LOOKS[ev.type] ?? FALLBACK;
  if (ev.type === 'exception' && ev.attrs.ouo_exception_fatal !== 'true') {
    return { ...look, color: (t) => t.colors.warning.main };
  }
  return look;
}

export function Timeline({ timeline, sessionStart, activeIndex, onSeek }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!timeline.length) {
    return <div className={styles.empty}>No events recorded for this session.</div>;
  }

  return (
    <ol className={styles.list} data-testid="timeline">
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
  list: css({ listStyle: 'none', margin: 0, padding: 0, maxHeight: 560, overflowY: 'auto' }),
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
