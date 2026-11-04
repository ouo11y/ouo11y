import { isAllScope, scopeFromSearch, scopeParams, withScope } from './useScope';

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
