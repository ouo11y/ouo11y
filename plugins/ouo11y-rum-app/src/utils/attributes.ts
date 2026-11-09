/** Attribute filters of the Sessions page: `attr.<key>=<value>` URL params (docs/specs/attributes.md). */

export const ATTR_PARAM_PREFIX = 'attr.';

/** The SDKs' and rum-api's key rule: a letter, then letters, digits and `_`, at most 40 characters. */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_VALUE = 128;

/** The `attr.*` params of a query, as `{ key: value }` sorted by key. */
export function attributeFilters(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  const keys: string[] = [];
  search.forEach((_v, name) => {
    if (name.startsWith(ATTR_PARAM_PREFIX)) {
      keys.push(name);
    }
  });
  for (const name of keys.sort()) {
    const value = search.get(name);
    if (value) {
      out[name.slice(ATTR_PARAM_PREFIX.length)] = value;
    }
  }
  return out;
}

/** `{ "attr.tenant": "acme" }` for the API and the URL. */
export function attributeParams(filters: Record<string, string>): Record<`attr.${string}`, string> {
  const out: Record<`attr.${string}`, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    out[`${ATTR_PARAM_PREFIX}${k}`] = v;
  }
  return out;
}

/** Parses `key=value` typed in the filter box (first `=` splits; spaces around both trimmed). */
export function parseAttributeInput(text: string): { key: string; value: string } | { error: string } {
  const i = text.indexOf('=');
  if (i < 0) {
    return { error: 'Type key=value, for example tenant=acme' };
  }
  const key = text.slice(0, i).trim();
  const value = text.slice(i + 1).trim();
  if (!KEY_RE.test(key)) {
    return { error: 'The key is a letter, then letters, digits or _, at most 40 characters' };
  }
  if (!value || [...value].length > MAX_VALUE || /\p{Cc}/u.test(value)) {
    return { error: `The value is 1 to ${MAX_VALUE} characters, no control characters` };
  }
  return { key, value };
}

/** Sessions page link filtered by one attribute. */
export function attributeSessionsSearch(key: string, value: string, range: { from: string; to: string }): string {
  return new URLSearchParams({ from: range.from, to: range.to, [`${ATTR_PARAM_PREFIX}${key}`]: value }).toString();
}
