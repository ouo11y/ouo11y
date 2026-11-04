import { useMemo } from 'react';
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
