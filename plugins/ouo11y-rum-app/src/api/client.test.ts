import { throwError } from 'rxjs';
import { READ_TOKEN_REJECTED, RumApiError, buildUrl, rumGet } from './client';

const fetchMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: fetchMock }),
  isFetchError: (e: unknown) => typeof e === 'object' && e !== null && 'status' in e && 'data' in e,
}));

const fetchError = (status: number, data: unknown) =>
  throwError(() => ({ status, statusText: 'x', data, config: { url: '' } }));

describe('rumGet', () => {
  beforeEach(() => fetchMock.mockReset());

  it('builds proxied urls and drops empty params', () => {
    expect(buildUrl('/v1/sessions', { from: 'now-1h', platform: '', limit: 10 })).toBe(
      '/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions?from=now-1h&limit=10'
    );
  });

  it('turns a 401 from rum-api into an unauthorized RumApiError with the read token hint', async () => {
    fetchMock.mockReturnValue(fetchError(401, { error: 'unauthorized' }));
    const err = await rumGet('/v1/sessions').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RumApiError);
    const apiErr = err as RumApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.unauthorized).toBe(true);
    expect(apiErr.message).toContain(READ_TOKEN_REJECTED);
    expect(apiErr.message).toContain('OUO_READ_TOKEN');
    expect(apiErr.url).toBe('/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions');
  });

  it('keeps the reachability hint for 502 and is not unauthorized', async () => {
    fetchMock.mockReturnValue(fetchError(502, 'bad gateway'));
    const err = (await rumGet('/healthz').catch((e: unknown) => e)) as RumApiError;
    expect(err.status).toBe(502);
    expect(err.unauthorized).toBe(false);
    expect(err.message).toContain('is rum-api running');
  });
});
