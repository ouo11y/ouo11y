import {
  conditionsProblem,
  conditionToString,
  failureFromSearch,
  failureParam,
  filtersFromSearch,
  parseConditions,
  parseStep,
  stepLabel,
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

describe('funnel step conditions (ADR-0019)', () => {
  it('round-trips conditions in the compact form, quoting non-token values', () => {
    for (const raw of [
      'event:checkout.submit where payment.method=card',
      'event:checkout.submit where payment.method=card and note="two words" and plan=~"pro|team" and coupon!=""',
      'event:pay where reason="a \\"quoted\\" and odd value"',
    ]) {
      const step = parseStep(raw);
      expect(step).toBeDefined();
      expect(stepToString(step!)).toBe(raw);
    }
    expect(parseStep('event:checkout.submit where payment.method = card  and  amount!=0')).toEqual({
      kind: 'event',
      value: 'checkout.submit',
      where: [
        { key: 'payment.method', op: '=', value: 'card' },
        { key: 'amount', op: '!=', value: '0' },
      ],
    });
    expect(conditionToString({ key: 'k', value: 'ünï"x' })).toBe('k="ünï\\"x"');
  });

  it('drops malformed conditions', () => {
    for (const bad of [
      'event:x where ',
      'event:x where a',
      'event:x where =b',
      'event:x where a=b or c=d',
      'event:x where a="unterminated',
      'event:x where a="v" b=c',
    ]) {
      expect(parseStep(bad)).toBeUndefined();
    }
    expect(parseConditions('a=1 and b=~"x|y"')).toEqual([
      { key: 'a', op: '=', value: '1' },
      { key: 'b', op: '=~', value: 'x|y' },
    ]);
  });

  it('labels and checks conditional steps', () => {
    const step = { kind: 'event' as const, value: 'pay', where: [{ key: 'payment.method', value: 'card' }] };
    expect(stepLabel(step)).toBe('pay where payment.method=card');
    expect(stepsProblem([{ kind: 'page', value: '/' }, step])).toBeUndefined();
    expect(
      stepsProblem([
        { kind: 'page', value: '/' },
        { kind: 'event', value: 'pay', where: [{ key: 'bad key', value: 'x' }] },
      ])
    ).toMatch(/Step 2: "bad key" is not an attribute name/);
    expect(
      stepsProblem([
        { kind: 'page', value: '/' },
        { kind: 'event', value: 'pay', where: [{ key: 'k', op: '=~', value: '' }] },
      ])
    ).toMatch(/empty pattern/);
    const six = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(conditionsProblem(six)).toMatch(/at most 5/);
  });

  it('reads and writes the failure event', () => {
    expect(failureFromSearch(new URLSearchParams(''))).toBeUndefined();
    expect(failureFromSearch(new URLSearchParams('failure=off'))).toEqual({ off: true });
    const f = failureFromSearch(new URLSearchParams({ failure: 'event:payment.failed where reason=declined' }));
    expect(f).toEqual({ event: 'payment.failed', where: [{ key: 'reason', op: '=', value: 'declined' }] });
    expect(failureParam(f)).toBe('event:payment.failed where reason=declined');
    expect(failureParam({ off: true })).toBe('off');
    expect(failureParam(undefined)).toBeUndefined();
    expect(failureFromSearch(new URLSearchParams('failure=page:/error'))).toBeUndefined();
  });
});
