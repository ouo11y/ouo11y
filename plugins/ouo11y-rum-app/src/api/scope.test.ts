import { of } from 'rxjs';
import { rumApi, videoSegmentUrl } from './client';

const fetchMock = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: fetchMock }),
  isFetchError: () => false,
}));

describe('rum-api calls carry the project / app scope', () => {
  beforeEach(() => fetchMock.mockReset().mockReturnValue(of({ data: {} })));
  const urls = () => fetchMock.mock.calls.map((c) => (c[0] as { url: string }).url);
  const base = '/api/plugin-proxy/ouo11y-rum-app/rum';
  const scope = { project: 'shop', service: 'shop-web' };

  it('sends project and service on every read', async () => {
    await rumApi.projects({ from: 'now-7d', to: 'now' });
    await rumApi.health({ from: 'now-1h', ...scope });
    await rumApi.sessions({ from: 'now-1h', ...scope });
    await rumApi.session('s1', scope);
    await rumApi.traces('s1', scope);
    await rumApi.logs('s1', scope);
    await rumApi.vitals('s1', scope);
    await rumApi.replayMeta('s1', scope);
    await rumApi.replayEvents('s1', scope);
    await rumApi.replayFrames('s1', scope);
    await rumApi.replayVideo('s1', scope);
    const q = 'project=shop&service=shop-web';
    expect(urls()).toEqual([
      `${base}/v1/projects?from=now-7d&to=now`,
      `${base}/v1/stats/health?from=now-1h&${q}`,
      `${base}/v1/sessions?from=now-1h&${q}`,
      `${base}/v1/sessions/s1?${q}`,
      `${base}/v1/sessions/s1/traces?${q}`,
      `${base}/v1/sessions/s1/logs?${q}`,
      `${base}/v1/sessions/s1/vitals?${q}`,
      `${base}/v1/sessions/s1/replay?${q}`,
      `${base}/v1/sessions/s1/replay/events?${q}`,
      `${base}/v1/sessions/s1/replay/frames?${q}`,
      `${base}/v1/sessions/s1/replay/video?${q}`,
    ]);
  });

  it('sends nothing for the all scope', async () => {
    await rumApi.replayEvents('s1');
    expect(urls()).toEqual([`${base}/v1/sessions/s1/replay/events`]);
  });

  it('adds the scope to video segment urls', () => {
    expect(videoSegmentUrl('s1', { seq: 2, path: '/v1/sessions/s1/replay/video/2' }, { project: 'shop' })).toBe(
      `${base}/v1/sessions/s1/replay/video/2?project=shop`
    );
    expect(videoSegmentUrl('s1', { seq: 0, path: '' })).toBe(`${base}/v1/sessions/s1/replay/video/0`);
    expect(videoSegmentUrl('s1', { seq: 1, path: '/v1/x?a=1' }, { project: 'p', service: '' })).toBe(
      `${base}/v1/x?a=1&project=p`
    );
  });
});
