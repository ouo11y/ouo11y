import type { FunnelCondition, FunnelConditionOp, FunnelFailure, FunnelFilters, FunnelStep } from '../api/types';

/** At most this many conditions per event step (docs/specs/funnels.md). */
export const MAX_CONDITIONS = 5;
/** An attribute name as the SDKs send it (rum-api refuses anything else). */
export const CONDITION_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const WHERE = ' where ';
/** A condition value that needs no quotes in the compact form. */
const TOKEN = /^[\p{L}\p{N}_.:/@+-]+$/u;

/** `key=value`, the value JSON-quoted (= Go-quoted for printable text) unless it is a bare token. */
export function conditionToString(c: FunnelCondition): string {
  const v = TOKEN.test(c.value) ? c.value : JSON.stringify(c.value);
  return `${c.key}${c.op ?? '='}${v}`;
}

/** Reads `k=v and k2!="x y" and k3=~"a|b"`; undefined when malformed. */
export function parseConditions(raw: string): FunnelCondition[] | undefined {
  const out: FunnelCondition[] = [];
  let s = raw;
  for (;;) {
    s = s.trimStart();
    const i = s.search(/[=!]/);
    if (i <= 0) {
      return undefined;
    }
    const key = s.slice(0, i).trim();
    s = s.slice(i);
    let op: FunnelConditionOp;
    if (s.startsWith('!=')) {
      op = '!=';
    } else if (s.startsWith('=~')) {
      op = '=~';
    } else if (s.startsWith('=')) {
      op = '=';
    } else {
      return undefined;
    }
    s = s.slice(op.length).trimStart();
    let value: string;
    if (s.startsWith('"')) {
      let j = 1;
      while (j < s.length && s[j] !== '"') {
        j += s[j] === '\\' ? 2 : 1;
      }
      if (j >= s.length) {
        return undefined;
      }
      try {
        value = JSON.parse(s.slice(0, j + 1));
      } catch {
        return undefined;
      }
      s = s.slice(j + 1);
    } else {
      const j = s.indexOf(' ');
      value = j < 0 ? s : s.slice(0, j);
      s = j < 0 ? '' : s.slice(j);
    }
    out.push({ key, op, value });
    s = s.trimStart();
    if (s === '') {
      return out;
    }
    if (!s.startsWith('and ')) {
      return undefined;
    }
    s = s.slice(4);
  }
}

/**
 * Compact step form shared with rum-api (`GET /v1/funnels/dropped?steps=`) and the page URL:
 * `page:/cart`, `page:/products/*` (prefix match), `event:add_to_cart`,
 * `event:checkout.submit where payment.method=card and note="two words"`.
 */
export function stepToString(step: FunnelStep): string {
  if (step.kind === 'page') {
    return `page:${step.value}${step.match === 'prefix' ? '*' : ''}`;
  }
  const where = step.where?.length ? WHERE + step.where.map(conditionToString).join(' and ') : '';
  return `event:${step.value}${where}`;
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
    const w = value.indexOf(WHERE);
    if (w < 0) {
      return { kind: 'event', value };
    }
    const where = parseConditions(value.slice(w + WHERE.length));
    return where ? { kind: 'event', value: value.slice(0, w), where } : undefined;
  }
  return undefined;
}

/**
 * The failure event lives in the URL as `failure`: absent = rum-api's default (`exception`), `off`, or
 * the compact event form (`event:payment.failed where reason=declined`).
 */
export function failureFromSearch(search: URLSearchParams): FunnelFailure | undefined {
  const raw = search.get('failure');
  if (!raw) {
    return undefined;
  }
  if (raw === 'off') {
    return { off: true };
  }
  const st = parseStep(raw);
  return st?.kind === 'event' && st.value ? { event: st.value, where: st.where } : undefined;
}

/** Value of the `failure` parameter (URL and rum-api GETs); undefined for the default. */
export function failureParam(f: FunnelFailure | undefined): string | undefined {
  if (!f) {
    return undefined;
  }
  if (f.off) {
    return 'off';
  }
  return f.event ? stepToString({ kind: 'event', value: f.event, where: f.where }) : undefined;
}

/** Why a step's conditions cannot be sent; undefined when they can. */
export function conditionsProblem(where: FunnelCondition[] | undefined): string | undefined {
  if ((where?.length ?? 0) > MAX_CONDITIONS) {
    return `at most ${MAX_CONDITIONS} conditions`;
  }
  for (const c of where ?? []) {
    if (!CONDITION_KEY.test(c.key)) {
      return `"${c.key}" is not an attribute name (letters, digits, _ . -)`;
    }
    if (c.op === '=~' && !c.value) {
      return `${c.key} matches: empty pattern`;
    }
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
  for (const [i, s] of steps.entries()) {
    const p = conditionsProblem(s.where);
    if (p) {
      return `Step ${i + 1}: ${p}.`;
    }
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
  return step.where?.length ? `${step.value} where ${step.where.map(conditionToString).join(' and ')}` : step.value;
}

/** Search params of the Funnels page for a set of steps (keeps every other parameter). */
export function withSteps(search: URLSearchParams, steps: FunnelStep[]): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete('step');
  next.delete('dropped');
  next.delete('outcome');
  for (const s of steps) {
    next.append('step', stepToString(s));
  }
  return next;
}
