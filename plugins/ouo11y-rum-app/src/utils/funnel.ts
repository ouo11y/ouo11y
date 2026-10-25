import type { FunnelFilters, FunnelStep } from '../api/types';

/**
 * Compact step form shared with rum-api (`GET /v1/funnels/dropped?steps=`) and the page URL:
 * `page:/cart`, `page:/products/*` (prefix match), `event:add_to_cart`.
 */
export function stepToString(step: FunnelStep): string {
  if (step.kind === 'page') {
    return `page:${step.value}${step.match === 'prefix' ? '*' : ''}`;
  }
  return `event:${step.value}`;
}

export function parseStep(raw: string): FunnelStep | undefined {
  const idx = raw.indexOf(':');
  if (idx < 0) {
    return undefined;
  }
  const kind = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (kind === 'page') {
    if (value.endsWith('*')) {
      return { kind: 'page', match: 'prefix', value: value.slice(0, -1) };
    }
    return { kind: 'page', match: 'exact', value };
  }
  if (kind === 'event') {
    return { kind: 'event', value };
  }
  return undefined;
}

/** Steps live in the URL as repeated `step` parameters, in order, so a funnel can be shared. */
export function stepsFromSearch(search: URLSearchParams): FunnelStep[] {
  return search
    .getAll('step')
    .map(parseStep)
    .filter((s): s is FunnelStep => s !== undefined);
}

/** Value for the `steps` query parameter of rum-api (comma separated). */
export function stepsParam(steps: FunnelStep[]): string {
  return steps.map(stepToString).join(',');
}

/** Why the step list cannot be queried yet; undefined when it can. */
export function stepsProblem(steps: FunnelStep[]): string | undefined {
  if (steps.length < 2) {
    return 'Add at least two steps.';
  }
  if (steps.length > 10) {
    return 'A funnel has at most 10 steps.';
  }
  const empty = steps.findIndex((s) => !s.value);
  if (empty >= 0) {
    return `Step ${empty + 1}: pick ${steps[empty].kind === 'page' ? 'a page path' : 'an event name'}.`;
  }
  const bad = steps.findIndex((s) => s.kind === 'page' && !s.value.startsWith('/'));
  if (bad >= 0) {
    return `Step ${bad + 1}: a page path starts with /.`;
  }
  return undefined;
}

export const FILTER_KEYS = ['service', 'environment', 'release', 'platform', 'project'] as const;

export function filtersFromSearch(search: URLSearchParams): FunnelFilters {
  const out: FunnelFilters = {};
  for (const k of FILTER_KEYS) {
    const v = search.get(k);
    if (v) {
      out[k] = v;
    }
  }
  return out;
}

/** Human label of a step. */
export function stepLabel(step: FunnelStep): string {
  if (step.kind === 'page') {
    return step.match === 'prefix' ? `${step.value}*` : step.value;
  }
  return step.value;
}

/** Search params of the Funnels page for a set of steps (keeps every other parameter). */
export function withSteps(search: URLSearchParams, steps: FunnelStep[]): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete('step');
  next.delete('dropped');
  for (const s of steps) {
    next.append('step', stepToString(s));
  }
  return next;
}
