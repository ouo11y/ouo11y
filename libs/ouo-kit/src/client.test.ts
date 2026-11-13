import { describe, expect, it } from 'vitest';
import { BffError, createBffClient } from './client';

function fakeFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: 'X' });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('createBffClient', () => {
  it('builds paths and drops empty query values', async () => {
    const { f, calls } = fakeFetch(200, { funnels: [] });
    const c = createBffClient({ baseUrl: '/api/plugins/x/resources/', fetch: f });
    await c.funnel('shop', { from: 1, to: 2, project: '', platform: 'ios' });
    await c.funnelDropped('shop', 3, { outcome: 'failed' });
    await c.overview();
    expect(calls).toEqual([
      '/api/plugins/x/resources/v1/funnels/shop?from=1&to=2&platform=ios',
      '/api/plugins/x/resources/v1/funnels/shop/steps/3/sessions?outcome=failed',
      '/api/plugins/x/resources/v1/overview',
    ]);
  });

  it('turns a 403 into a forbidden BffError with the backend message', async () => {
    const { f } = fakeFetch(403, { error: 'clearance too low' });
    const err = await createBffClient({ baseUrl: '/b', fetch: f })
      .manifest('demo', 'a'.repeat(32), 'b'.repeat(32))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BffError);
    expect((err as BffError).forbidden).toBe(true);
    expect((err as BffError).message).toBe('clearance too low');
  });

  it('keeps the status text when the body is not JSON', async () => {
    const { f } = fakeFetch(502, 'gateway');
    const err = (await createBffClient({ baseUrl: '/b', fetch: f }).me().catch((e: unknown) => e)) as BffError;
    expect(err.status).toBe(502);
    expect(err.forbidden).toBe(false);
    expect(err.message).toBe('X');
  });
});
