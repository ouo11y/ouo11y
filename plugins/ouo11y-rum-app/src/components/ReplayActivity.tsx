import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, Input, useStyles2, useTheme2 } from '@grafana/ui';
import { activeActivityIndex, matchesFilter, type ActivityFilter, type ActivityItem } from '../utils/activity';
import { formatDateTime, formatRelative } from '../utils/format';
import { scrollRowIntoView } from '../utils/scroll';
import { hasPosition, type ReplayTap } from '../utils/taps';
import { StackTrace } from './StackTrace';
import { eventLook } from './Timeline';

interface Props {
  items: readonly ActivityItem[];
  /** Replay length; a click seeks to the item's offset clamped to `[0, durationMs]`. */
  durationMs: number;
  /** Current replay offset (ms); -1 (or no replay) highlights nothing. */
  currentMs: number;
  /** Absent without a replay: rows are not clickable then. */
  onSeek?: (offsetMs: number, item: ActivityItem) => void;
  /**
   * Origin of the times shown on the rows (epoch ms): the session start, so the list, the Timeline
   * and the player read the same clock. Defaults to the replay start (the item offsets).
   */
  clockStart?: number;
}

const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tap', label: 'Taps' },
  { value: 'navigation', label: 'Navigation' },
  { value: 'network', label: 'Network' },
  { value: 'error', label: 'Errors' },
  { value: 'log', label: 'Logs' },
];

/** Orange of the tap indicator on the video (TapOverlay). */
const TAP_COLOR = '#ff7a1a';

function tapText(tap: ReplayTap): { title: string; detail: string } {
  const title = tap.drag ? 'Swipe' : 'Tap';
  const where = hasPosition(tap) ? `at ${Math.round(tap.x)}, ${Math.round(tap.y)}` : 'no position in the recording';
  if (tap.target) {
    return { title: `${title} ${tap.target}`, detail: [tap.path, where].filter(Boolean).join(' · ') };
  }
  return { title, detail: where };
}

function rowText(item: ActivityItem): { title: string; detail: string } {
  if (item.tap) {
    return tapText(item.tap);
  }
  const look = eventLook(item.event!);
  return { title: look.title(item.event!), detail: look.detail(item.event!) };
}

/**
 * The replay's activity next to the player, like the breadcrumb panel of Sentry's replay view:
 * taps, navigations, requests, errors and logs in time order, filterable, with the row at the
 * replay cursor highlighted and kept in view, and click-to-seek.
 */
export function ReplayActivity({ items, durationMs, currentMs, onSeek, clockStart }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  const counts = useMemo(() => {
    const c = {} as Record<ActivityFilter, number>;
    for (const f of FILTERS) {
      c[f.value] = items.filter((it) => matchesFilter(it, f.value)).length;
    }
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => matchesFilter(it, filter))
      .map((it) => ({ item: it, text: rowText(it) }))
      .filter(({ text }) => !q || `${text.title} ${text.detail}`.toLowerCase().includes(q));
  }, [items, filter, query]);

  const active =
    currentMs < 0
      ? -1
      : activeActivityIndex(
          shown.map((s) => s.item),
          currentMs
        );

  useEffect(() => {
    const list = listRef.current;
    const item = activeRef.current;
    if (!list || !item) {
      return;
    }
    const frame = requestAnimationFrame(() => scrollRowIntoView(list, item));
    return () => cancelAnimationFrame(frame);
  }, [active, filter]);

  return (
    <div className={styles.wrap} data-testid="replay-activity">
      <div className={styles.filters} role="tablist" aria-label="Activity filter">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            className={cx(styles.filter, filter === f.value && styles.filterOn)}
            onClick={() => setFilter(f.value)}
            data-testid={`activity-filter-${f.value}`}
            disabled={f.value !== 'all' && counts[f.value] === 0}
          >
            {f.label} <span className={styles.count}>{counts[f.value]}</span>
          </button>
        ))}
      </div>
      <Input
        className={styles.search}
        prefix={<Icon name="search" />}
        placeholder="Search activity"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        aria-label="Search activity"
      />
      {shown.length === 0 ? (
        <div className={styles.empty}>No activity{filter !== 'all' || query ? ' matches' : ''}.</div>
      ) : (
        <ol ref={listRef} className={styles.list} data-testid="activity-list">
          {shown.map(({ item, text }, i) => {
            const isActive = i === active;
            const isTap = item.category === 'tap';
            const look = item.event && !isTap ? eventLook(item.event) : undefined;
            const color = isTap ? TAP_COLOR : look!.color(theme);
            return (
              <li
                key={item.key}
                ref={isActive ? activeRef : undefined}
                className={cx(
                  styles.item,
                  onSeek && styles.clickable,
                  isActive && styles.active,
                  currentMs >= 0 && item.offsetMs > currentMs && styles.future
                )}
                onClick={onSeek ? () => onSeek(Math.max(0, Math.min(durationMs, item.offsetMs)), item) : undefined}
                title={
                  item.event?.clampedFrom
                    ? `${formatDateTime(item.event.clampedFrom)}: recorded before the session start`
                    : formatDateTime(item.ts)
                }
                data-testid="activity-item"
                data-category={item.category}
                data-active={isActive ? 'true' : undefined}
              >
                <span className={styles.icon} style={{ color }}>
                  <Icon name={isTap ? 'hand-pointer' : look!.icon} />
                </span>
                <span className={styles.body}>
                  <span className={styles.title}>{text.title}</span>
                  {text.detail && <span className={styles.detail}>{text.detail}</span>}
                  {item.event?.type === 'exception' && <StackTrace stack={item.event.attrs.exception_stacktrace} />}
                </span>
                <span className={styles.time}>
                  {formatRelative(Number.isFinite(clockStart) ? item.ts - clockStart! : item.offsetMs)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  filters: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    padding: theme.spacing(1, 1, 0.5),
  }),
  filter: css({
    border: `1px solid ${theme.colors.border.weak}`,
    background: 'transparent',
    color: theme.colors.text.secondary,
    borderRadius: 12,
    padding: theme.spacing(0, 1),
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: '20px',
    cursor: 'pointer',
    '&:disabled': { opacity: 0.45, cursor: 'default' },
    '&:hover:not(:disabled)': { background: theme.colors.action.hover },
  }),
  filterOn: css({
    color: theme.colors.text.primary,
    borderColor: theme.colors.primary.border,
    background: theme.colors.action.selected,
  }),
  count: css({ color: theme.colors.text.secondary, marginLeft: 2 }),
  search: css({ padding: theme.spacing(0.5, 1) }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    borderTop: `1px solid ${theme.colors.border.weak}`,
  }),
  item: css({
    display: 'grid',
    gridTemplateColumns: '18px 1fr auto',
    gap: theme.spacing(1),
    alignItems: 'start',
    padding: theme.spacing(0.5, 1),
    borderLeft: '3px solid transparent',
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  clickable: css({ cursor: 'pointer', '&:hover': { background: theme.colors.action.hover } }),
  active: css({ background: theme.colors.action.selected, borderLeftColor: theme.colors.primary.main }),
  // Rows after the cursor are dimmed, like Sentry's list.
  future: css({ opacity: 0.6 }),
  icon: css({ paddingTop: 1 }),
  body: css({ display: 'flex', flexDirection: 'column', minWidth: 0 }),
  title: css({
    fontWeight: theme.typography.fontWeightMedium,
    fontSize: theme.typography.bodySmall.fontSize,
    overflowWrap: 'anywhere',
  }),
  detail: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    overflowWrap: 'anywhere',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }),
  time: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    paddingTop: 1,
    whiteSpace: 'nowrap',
  }),
  empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(1) }),
});
