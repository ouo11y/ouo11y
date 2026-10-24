import {
  filtersFromSearch,
  parseStep,
  stepToString,
  stepsFromSearch,
  stepsParam,
  stepsProblem,
  withSteps,
} from './funnel';

describe('funnel steps', () => {
  it('round-trips the compact form', () => {
    for (const raw of ['page:/', 'page:/products/*', 'event:add_to_cart', 'event:a:b']) {
      const step = parseStep(raw);
      expect(step).toBeDefined();
      expect(stepToString(step!)).toBe(raw);
    }
    expect(parseStep('page:/products/*')).toEqual({ kind: 'page', match: 'prefix', value: '/products/' });
    expect(parseStep('click:#buy')).toBeUndefined();
    expect(parseStep('nonsense')).toBeUndefined();
  });

  it('reads ordered steps and filters from the URL', () => {
    const search = new URLSearchParams('step=page:/&step=event:checkout&step=bad&service=shop&from=now-1h');
    expect(stepsFromSearch(search)).toEqual([
      { kind: 'page', match: 'exact', value: '/' },
      { kind: 'event', value: 'checkout' },
    ]);
    expect(filtersFromSearch(search)).toEqual({ service: 'shop' });
    expect(stepsParam(stepsFromSearch(search))).toBe('page:/,event:checkout');
  });

  it('writes steps back and keeps other params', () => {
    const next = withSteps(new URLSearchParams('from=now-1h&step=page:/x&dropped=2'), [
      { kind: 'page', match: 'prefix', value: '/p/' },
      { kind: 'event', value: 'paid' },
    ]);
    expect(next.getAll('step')).toEqual(['page:/p/*', 'event:paid']);
    expect(next.get('from')).toBe('now-1h');
    expect(next.get('dropped')).toBeNull();
  });

  it('explains what blocks a query', () => {
    expect(stepsProblem([{ kind: 'page', value: '/' }])).toMatch(/two steps/);
    expect(
      stepsProblem([
        { kind: 'page', value: '/' },
        { kind: 'page', value: 'cart' },
      ])
    ).toMatch(/Step 2/);
    expect(
      stepsProblem([
        { kind: 'page', value: '/' },
        { kind: 'event', value: '' },
      ])
    ).toMatch(/event name/);
    expect(
      stepsProblem([
        { kind: 'page', value: '/' },
        { kind: 'event', value: 'x' },
      ])
    ).toBeUndefined();
  });
});
