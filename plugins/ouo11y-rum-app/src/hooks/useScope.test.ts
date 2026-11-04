import {
  isAllScope,
  isOtherScope,
  loadScope,
  reconcileScope,
  saveScope,
  scopeFromSearch,
  scopeKeyTag,
  scopeParams,
  scopeStorageKey,
  withScope,
} from './useScope';

jest.mock('@grafana/runtime', () => ({ config: { bootData: { user: { orgId: 3 } } } }));

describe('scope helpers', () => {
  it('reads project and service from the URL; missing means all', () => {
    expect(scopeFromSearch(new URLSearchParams('project=shop&service=shop-web&from=now-1h'))).toEqual({
      project: 'shop',
      service: 'shop-web',
    });
    const all = scopeFromSearch(new URLSearchParams('from=now-1h'));
    expect(all).toEqual({ project: '', service: '' });
    expect(isAllScope(all)).toBe(true);
    expect(isAllScope({ project: '', service: 'x' })).toBe(false);
  });

  it('sends only the set parts to rum-api', () => {
    expect(scopeParams({ project: '', service: '' })).toEqual({});
    expect(scopeParams({ project: 'shop', service: '' })).toEqual({ project: 'shop' });
    expect(scopeParams({ project: 'shop', service: 'shop-ios' })).toEqual({ project: 'shop', service: 'shop-ios' });
  });

  it('copies the scope into a query and removes it for all', () => {
    const q = new URLSearchParams('from=now-1h&project=old&service=old-app');
    expect(withScope(q, { project: 'bank', service: '' }).toString()).toBe('from=now-1h&project=bank');
    expect(withScope(q, { project: '', service: '' }).toString()).toBe('from=now-1h');
  });
});

describe('isOtherScope', () => {
  it('flags data of another scope but not of another time range', () => {
    const shop = { project: 'shop', service: '' };
    const key = (range: string, s: { project: string; service: string }) => `${range}${scopeKeyTag(s)}`;
    expect(isOtherScope(undefined, shop)).toBe(false);
    expect(isOtherScope(key('now-1h|now', shop), shop)).toBe(false);
    expect(isOtherScope(key('now-6h|now', shop), shop)).toBe(false);
    expect(isOtherScope(key('now-1h|now', { project: '', service: '' }), shop)).toBe(true);
    expect(isOtherScope(key('now-1h|now', { project: 'shop', service: 'web' }), shop)).toBe(true);
  });
});

describe('remembered scope', () => {
  beforeEach(() => window.localStorage.clear());
  const shop = { project: 'shop', service: 'shop-web' };
  const all = { project: '', service: '' };

  it('is stored per Grafana org', () => {
    expect(scopeStorageKey()).toBe('ouo11y-rum-app.scope.3');
    expect(scopeStorageKey(1)).toBe('ouo11y-rum-app.scope.1');
    saveScope(shop);
    expect(loadScope()).toEqual(shop);
    expect(loadScope(scopeStorageKey(1))).toBeUndefined();
  });

  it('survives garbage and missing fields', () => {
    window.localStorage.setItem(scopeStorageKey(), 'not json');
    expect(loadScope()).toBeUndefined();
    window.localStorage.setItem(scopeStorageKey(), '{"project":"bank","service":7}');
    expect(loadScope()).toEqual({ project: 'bank', service: '' });
  });

  it('restores the remembered scope on a page opened without one', () => {
    expect(reconcileScope(all, shop)).toEqual({ restore: shop });
  });

  it('lets an explicit URL scope win and remembers it', () => {
    expect(reconcileScope({ project: 'bank', service: '' }, shop)).toEqual({ save: { project: 'bank', service: '' } });
  });

  it('does nothing when the remembered scope is all (All projects / All apps was picked) or nothing is stored', () => {
    expect(reconcileScope(all, all)).toEqual({});
    expect(reconcileScope(all, undefined)).toEqual({});
  });
});
