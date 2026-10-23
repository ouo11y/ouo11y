import type { TimelineEvent, VitalRating, VitalsResponse } from '../api/types';

// Mobile vitals (docs/specs/mobile-vitals.md). Timeline entries carry the Loki attributes (`.` -> `_`), so the
// titles and ratings here read those; the thresholds are the spec's section 4, the same as rum-api's.

/** `good` below `good`, `poor` from `poor`, `needs-improvement` between. */
function rate(value: number, good: number, poor: number): VitalRating {
  if (value < good) {
    return 'good';
  }
  return value >= poor ? 'poor' : 'needs-improvement';
}

export function rateAppStart(type: string | undefined, ms: number): VitalRating | undefined {
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  switch (type) {
    case 'cold':
      return rate(ms, 2000, 5000);
    case 'warm':
      return rate(ms, 1000, 2000);
    default:
      return undefined;
  }
}

export function rateTtid(ms: number): VitalRating | undefined {
  return Number.isFinite(ms) ? rate(ms, 1000, 2500) : undefined;
}

/** The worse of the slow-frame ratio (< 5 % good, >= 25 % poor) and the frozen frames (0 good, >= 1 poor). */
export function rateFrames(total: number, slow: number, frozen: number): VitalRating | undefined {
  if (!(total > 0)) {
    return undefined;
  }
  if (frozen > 0) {
    return 'poor';
  }
  return rate((slow || 0) / total, 0.05, 0.25);
}

/** A stall window by its total stall time: 0 good, >= 1 s poor. */
export function rateStalls(totalMs: number): VitalRating | undefined {
  if (!Number.isFinite(totalMs)) {
    return undefined;
  }
  return totalMs <= 0 ? 'good' : rate(totalMs, 0, 1000);
}

const RANK: Record<VitalRating, number> = { good: 1, 'needs-improvement': 2, poor: 3 };

export function worstRating(ratings: ReadonlyArray<VitalRating | undefined>): VitalRating | undefined {
  let worst: VitalRating | undefined;
  for (const r of ratings) {
    if (r && (!worst || RANK[r] > RANK[worst])) {
      worst = r;
    }
  }
  return worst;
}

export function isVitalEvent(ev: Pick<TimelineEvent, 'type' | 'name'>): boolean {
  return (
    ev.type === 'vital' ||
    ev.name === 'ouo.app.start' ||
    ev.name === 'ouo.screen.display' ||
    ev.name === 'app.jank' ||
    ev.name === 'ouo.stall'
  );
}

function num(attrs: Record<string, string>, key: string): number {
  const raw = attrs[key];
  if (raw === undefined || raw.trim() === '') {
    return NaN;
  }
  return Number(raw);
}

/** A vital duration: `220 ms` below a second, `3.06 s` from one second. */
export function formatVitalMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '–';
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Rating of one vital timeline entry, from its attributes. */
export function vitalRating(ev: TimelineEvent): VitalRating | undefined {
  const a = ev.attrs;
  switch (ev.name) {
    case 'ouo.app.start':
      return rateAppStart(a.ouo_app_start_type, num(a, 'ouo_app_start_duration_ms'));
    case 'ouo.screen.display':
      return rateTtid(num(a, 'ouo_screen_ttid_ms'));
    case 'app.jank':
      return rateFrames(num(a, 'ouo_frames_total'), num(a, 'ouo_frames_slow'), num(a, 'ouo_frames_frozen'));
    case 'ouo.stall':
      return rateStalls(num(a, 'ouo_stall_total_ms'));
    default:
      return undefined;
  }
}

/** Timeline title of a vital (spec section 8): `App start (cold) 3.06 s`, `Home displayed in 3.32 s`, ... */
export function vitalTitle(ev: TimelineEvent): string {
  const a = ev.attrs;
  switch (ev.name) {
    case 'ouo.app.start': {
      const type = a.ouo_app_start_type ? ` (${a.ouo_app_start_type})` : '';
      return `App start${type} ${formatVitalMs(num(a, 'ouo_app_start_duration_ms'))}`;
    }
    case 'ouo.screen.display':
      return `${a.app_screen_name || 'Screen'} displayed in ${formatVitalMs(num(a, 'ouo_screen_ttid_ms'))}`;
    case 'app.jank': {
      const total = num(a, 'ouo_frames_total');
      const slow = num(a, 'ouo_frames_slow');
      const frozen = num(a, 'ouo_frames_frozen');
      let janky = num(a, 'app_jank_frame_count');
      if (!Number.isFinite(janky)) {
        janky = (Number.isFinite(slow) ? slow : 0) + (Number.isFinite(frozen) ? frozen : 0);
      }
      const frozenText = frozen > 0 ? ` (${frozen} frozen)` : '';
      return `Janky frames ${janky} / ${Number.isFinite(total) ? total : '?'}${frozenText}`;
    }
    case 'ouo.stall': {
      const count = num(a, 'ouo_stall_count');
      const n = Number.isFinite(count) ? count : 0;
      return `${n} JS ${n === 1 ? 'stall' : 'stalls'}, longest ${formatVitalMs(num(a, 'ouo_stall_longest_ms'))}`;
    }
    default:
      return ev.name;
  }
}

/** Second line of a vital timeline entry: the screen and the values the title leaves out. */
export function vitalDetail(ev: TimelineEvent): string {
  const a = ev.attrs;
  const parts: string[] = [];
  switch (ev.name) {
    case 'ouo.app.start':
      if (a.app_screen_name) {
        parts.push(`first screen ${a.app_screen_name}`);
      }
      break;
    case 'ouo.screen.display': {
      const ttfd = num(a, 'ouo_screen_ttfd_ms');
      if (Number.isFinite(ttfd)) {
        parts.push(`fully displayed in ${formatVitalMs(ttfd)}`);
      }
      break;
    }
    case 'app.jank': {
      if (a.app_screen_name) {
        parts.push(a.app_screen_name);
      }
      const slow = num(a, 'ouo_frames_slow');
      if (Number.isFinite(slow)) {
        parts.push(`${slow} slow`);
      }
      const delay = num(a, 'ouo_frames_delay_ms');
      if (Number.isFinite(delay)) {
        parts.push(`${formatVitalMs(delay)} delay`);
      }
      break;
    }
    case 'ouo.stall': {
      if (a.app_screen_name) {
        parts.push(a.app_screen_name);
      }
      const total = num(a, 'ouo_stall_total_ms');
      if (Number.isFinite(total)) {
        parts.push(`${formatVitalMs(total)} stalled`);
      }
      break;
    }
  }
  if (a.ouo_vital_window) {
    parts.push(`${a.ouo_vital_window} window`);
  }
  return parts.join(' · ');
}

/** One item of the session header's vitals row. */
export interface VitalsHeaderItem {
  key: 'app_start' | 'ttid' | 'frames' | 'stalls';
  label: string;
  value: string;
  rating?: VitalRating;
}

/**
 * The compact vitals row of the session header (spec section 8): app start, TTID p50 / max, slow and frozen
 * frames, stalls. Empty when the session has no vitals (the row is hidden then). Colours: app start by its
 * rating, TTID by its p50, frames by the session's totals, stalls by the worst stall window.
 */
export function vitalsHeaderItems(data: VitalsResponse | undefined): VitalsHeaderItem[] {
  if (!data?.summary) {
    return [];
  }
  const { app_start, ttid_ms, frames, stalls } = data.summary;
  const out: VitalsHeaderItem[] = [];
  if (app_start) {
    out.push({
      key: 'app_start',
      label: app_start.type ? `${app_start.type[0].toUpperCase()}${app_start.type.slice(1)} start` : 'App start',
      value: formatVitalMs(app_start.duration_ms),
      rating: app_start.rating ?? rateAppStart(app_start.type, app_start.duration_ms),
    });
  }
  if (ttid_ms) {
    out.push({
      key: 'ttid',
      label: 'TTID',
      value: `p50 ${formatVitalMs(ttid_ms.p50)} · max ${formatVitalMs(ttid_ms.max)}`,
      rating: rateTtid(ttid_ms.p50),
    });
  }
  if (frames) {
    out.push({
      key: 'frames',
      label: 'Frames',
      value: `${frames.slow} slow · ${frames.frozen} frozen / ${frames.total}`,
      rating: rateFrames(frames.total, frames.slow, frames.frozen),
    });
  }
  if (stalls) {
    out.push({
      key: 'stalls',
      label: 'JS stalls',
      value: `${stalls.count} · longest ${formatVitalMs(stalls.longest_ms)}`,
      rating:
        worstRating(data.vitals.filter((v) => v.name === 'ouo.stall').map((v) => v.rating)) ??
        rateStalls(stalls.total_ms),
    });
  }
  return out;
}
