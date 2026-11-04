import { useMemo } from 'react';
import { config } from '@grafana/runtime';
import { useSearchParams } from './useSearchParams';

/**
 * The project and app (service.name) every page is scoped to, kept in the URL query (`project`,
 * `service`) so links and shared URLs keep it. Empty means "all": the cross-project overview.
 *
 * The scope narrows what a page shows; it is not an access boundary. rum-api has one read token,
 * so anyone with the plugin can pick any project (per-project tokens are Phase 11).
 */
export interface Scope {
  project: string;
  service: string;
}

export const ALL_SCOPE: Scope = { project: '', service: '' };

export function scopeFromSearch(search: URLSearchParams): Scope {
  return { project: search.get('project') ?? '', service: search.get('service') ?? '' };
}

/** rum-api query params of a scope; "all" sends nothing. */
export function scopeParams(scope: Scope): { project?: string; service?: string } {
  const out: { project?: string; service?: string } = {};
  if (scope.project) {
    out.project = scope.project;
  }
  if (scope.service) {
    out.service = scope.service;
  }
  return out;
}

/** Copies the scope into `q` (removing the keys for "all") and returns it. */
export function withScope(q: URLSearchParams, scope: Scope): URLSearchParams {
  for (const [k, v] of [
    ['project', scope.project],
    ['service', scope.service],
  ] as const) {
    if (v) {
      q.set(k, v);
    } else {
      q.delete(k);
    }
  }
  return q;
}

export function isAllScope(scope: Scope): boolean {
  return !scope.project && !scope.service;
}

export function useScope(): Scope {
  const search = useSearchParams();
  const project = search.get('project') ?? '';
  const service = search.get('service') ?? '';
  return useMemo(() => ({ project, service }), [project, service]);
}

/** Suffix of a query key that names the scope (see `scopeKeyTag` / `isOtherScope`). */
export function scopeKeyTag(scope: Scope): string {
  return `|scope:${scope.project}|${scope.service}`;
}

/**
 * True when data fetched for `dataKey` belongs to another scope than `scope`. Pages keep showing
 * the previous data while a new time range loads, but never another scope's numbers under the
 * new scope's labels.
 */
export function isOtherScope(dataKey: string | undefined, scope: Scope): boolean {
  return dataKey !== undefined && !dataKey.endsWith(scopeKeyTag(scope));
}

/**
 * localStorage key of the remembered scope, one per Grafana organisation (project ids of one
 * org mean nothing in another).
 */
export function scopeStorageKey(orgId: number | undefined = config?.bootData?.user?.orgId): string {
  return `ouo11y-rum-app.scope.${orgId ?? 0}`;
}

/** The scope last used in this org, or undefined (nothing stored, storage unavailable or garbage). */
export function loadScope(key = scopeStorageKey()): Scope | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return undefined;
    }
    const v = JSON.parse(raw) as Partial<Scope>;
    return {
      project: typeof v.project === 'string' ? v.project : '',
      service: typeof v.service === 'string' ? v.service : '',
    };
  } catch {
    return undefined;
  }
}

/** Remembers the scope; "all" is stored too, so picking All projects / All apps sticks. */
export function saveScope(scope: Scope, key = scopeStorageKey()): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ project: scope.project, service: scope.service }));
  } catch {
    // Private mode or storage disabled: the scope still works through the URL.
  }
}

/**
 * What to do with the remembered scope when a page opens: the URL's scope wins and is
 * remembered; a URL without one (Grafana's nav menu links, a bookmark of the bare page) gets the
 * remembered scope back, unless that is "all".
 */
export function reconcileScope(url: Scope, saved: Scope | undefined): { save?: Scope; restore?: Scope } {
  if (!isAllScope(url)) {
    return { save: url };
  }
  if (saved && !isAllScope(saved)) {
    return { restore: saved };
  }
  return {};
}
