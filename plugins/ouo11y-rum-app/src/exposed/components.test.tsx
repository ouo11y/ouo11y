import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PluginContextProvider, type AppPluginMeta } from '@grafana/data';
import { MemoryRouter } from 'react-router-dom';
import framesFixture from '../__fixtures__/frames.json';
import type { HealthResponse, ReplayFramesResponse, SessionDetail, SessionRecord } from '../api/types';
import { OverviewHealthV1, SessionDetailV1, SessionsListV1 } from './components';

const push = jest.fn();
const subscribe = jest.fn(() => ({ unsubscribe: () => undefined }));

// The host page's URL: an embedded component must never read it (or write it).
jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div data-testid="plugin-page">{children}</div>,
  locationService: {
    getSearch: () => new URLSearchParams('from=now-90d&to=now-60d&project=host&service=host-app'),
    getLocationObservable: () => ({ subscribe }),
    partial: () => {
      throw new Error('an embedded component wrote the host URL');
    },
    push: (...a: unknown[]) => push(...a),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const api = {
  session: jest.fn(),
  logs: jest.fn(),
  replayMeta: jest.fn(),
  replayFrames: jest.fn(),
  replayEvents: jest.fn(),
  replayVideo: jest.fn(),
  vitals: jest.fn(),
  sessions: jest.fn(),
  health: jest.fn(),
};
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: new Proxy({}, { get: (_t, k: string) => (api as Record<string, jest.Mock>)[k] }),
}));

// jsdom's URL has no canParse; Grafana's LinkButton sanitizes hrefs with it.
if (!('canParse' in URL)) {
  Object.assign(URL, {
    canParse: (u: string, base?: string) => {
      try {
        new URL(u, base);
        return true;
      } catch {
        return false;
      }
    },
  });
}

const frames = framesFixture as ReplayFramesResponse;
const iso = (ms: number) => new Date(ms).toISOString();

const record: SessionRecord = {
  session_id: 'frames-fixture-0001',
  user_id: 'u-42',
  platform: 'mobile',
  service_name: 'shop-ios',
  service_version: '1.4.0',
  started_at: iso(frames.started_at - 300),
  last_signal_at: iso(frames.ended_at),
  ended_at: iso(frames.ended_at),
  end_reason: 'background',
  state: 'ended',
  status: 'errored',
  error_count: 1,
  crash_count: 0,
  failed_request_count: 0,
  event_count: 2,
  trace_count: 0,
  has_replay: true,
  replay_kind: 'frames',
};

const detail: SessionDetail = {
  ...record,
  timeline: [
    { ts: iso(frames.started_at - 300), type: 'session.start', name: 'session.start', attrs: {} },
    {
      ts: iso(frames.started_at + 4000),
      type: 'exception',
      name: 'exception',
      attrs: { exception_type: 'Error', exception_message: 'coupon service unavailable' },
    },
  ],
  traces: [],
};

const bucket = (platform: string, total: number, healthy: number) => ({
  platform,
  service_name: platform === 'web' ? 'shop-web' : 'shop-ios',
  service_version: '1.4.0',
  total,
  healthy,
  errored: total - healthy,
  crashed: 0,
  healthy_pct: (100 * healthy) / total,
  errored_pct: (100 * (total - healthy)) / total,
  crashed_pct: 0,
});

const health: HealthResponse = {
  buckets: [bucket('web', 4, 3), bucket('mobile', 2, 2)],
  totals: { ...bucket('', 6, 5), service_name: '', service_version: '' },
  from: '2026-11-03T00:00:00Z',
  to: '2026-11-04T00:00:00Z',
};

beforeEach(() => {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  api.session.mockResolvedValue(detail);
  api.logs.mockResolvedValue({ session_id: detail.session_id, logs: [], count: 0, truncated: false, query: '' });
  api.replayMeta.mockResolvedValue({ session_id: detail.session_id, kind: 'frames', masked: true, chunks: [] });
  api.replayFrames.mockResolvedValue(frames);
  api.sessions.mockResolvedValue({ sessions: [record], count: 1, from: '', to: '' });
  api.health.mockResolvedValue(health);
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.values(api).forEach((m) => m.mockReset());
  push.mockReset();
  subscribe.mockClear();
});

const RANGE = { from: '2026-11-03T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' };

describe('ouo11y-rum-app/session-detail/v1', () => {
  it('renders the session and its replay from props, without a page header or the host URL', async () => {
    render(<SessionDetailV1 sessionId="frames-fixture-0001" timeRange={RANGE} project="shop" app="shop-ios" />);

    const header = await screen.findByTestId('session-header');
    expect(header).toHaveTextContent('frames-fixture-0001');
    // The replay player and its activity list render inside the embedded page.
    const replay = screen.getByTestId('panel-replay');
    expect(await within(replay).findByTestId('replay-activity')).toBeInTheDocument();
    expect(await within(replay).findByTestId('frame-player')).toBeInTheDocument();
    expect(screen.getByTestId('panel-traces')).toBeInTheDocument();

    // Props, not the host URL (from=now-90d, project=host), drive every call.
    expect(api.session).toHaveBeenCalledWith('frames-fixture-0001', expect.objectContaining(RANGE));
    expect(api.replayFrames).toHaveBeenCalledWith('frames-fixture-0001');
    // The host owns the page chrome: no PluginPage, no subscription to the host's location.
    expect(screen.queryByTestId('plugin-page')).toBeNull();
    expect(screen.getByTestId('ouo-embedded-page')).toBeInTheDocument();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('links out to ouo with the range from props', async () => {
    render(
      <SessionDetailV1
        sessionId="frames-fixture-0001"
        timeRange={{ from: Date.parse(RANGE.from), to: String(Date.parse(RANGE.to)) }}
      />
    );
    await screen.findByTestId('session-header');
    // Epoch milliseconds (number or string) reach rum-api as ISO.
    expect(api.session).toHaveBeenCalledWith('frames-fixture-0001', expect.objectContaining(RANGE));
  });

  it('defaults to the last 24 hours', async () => {
    render(<SessionDetailV1 sessionId="frames-fixture-0001" />);
    await screen.findByTestId('session-header');
    expect(api.session).toHaveBeenCalledWith(
      'frames-fixture-0001',
      expect.objectContaining({ from: 'now-24h', to: 'now' })
    );
  });

  it('asks for a session id instead of calling rum-api without one', () => {
    render(<SessionDetailV1 sessionId={'  '} />);
    expect(screen.getByTestId('ouo-embed-missing-session')).toHaveTextContent('sessionId');
    expect(api.session).not.toHaveBeenCalled();
  });

  it("turns on ouo's feature toggles from its own plugin settings", async () => {
    const meta = {
      id: 'ouo11y-rum-app',
      jsonData: { featureToggles: 'sessionTimelinePanel' },
    } as unknown as AppPluginMeta;
    render(
      <PluginContextProvider meta={meta}>
        <SessionDetailV1 sessionId="frames-fixture-0001" timeRange={RANGE} />
      </PluginContextProvider>
    );
    expect(await screen.findByTestId('panel-timeline')).toBeInTheDocument();
  });

  it('does not refetch when the host re-renders with equal props', async () => {
    const { rerender } = render(<SessionDetailV1 sessionId="frames-fixture-0001" timeRange={{ ...RANGE }} />);
    await screen.findByTestId('session-header');
    rerender(<SessionDetailV1 sessionId="frames-fixture-0001" timeRange={{ ...RANGE }} />);
    await screen.findByTestId('frame-player');
    expect(api.session).toHaveBeenCalledTimes(1);
  });
});

describe('ouo11y-rum-app/sessions-list/v1', () => {
  it('sends the filters, scope, range and limit from props to rum-api', async () => {
    render(
      <SessionsListV1
        timeRange={RANGE}
        project="shop"
        app="shop-ios"
        filters={{ platform: 'mobile', status: 'errored', version: '1.4.0', user: 'u-42' }}
        limit={5000}
      />
    );
    expect(await screen.findByText('frames-f…')).toBeInTheDocument();
    expect(api.sessions).toHaveBeenCalledWith({
      ...RANGE,
      project: 'shop',
      service: 'shop-ios',
      platform: 'mobile',
      status: 'errored',
      version: '1.4.0',
      user: 'u-42',
      limit: 1000,
    });
    expect(screen.getByTestId('ouo-sessions-list')).toHaveTextContent('1 session');
  });

  it('hands a clicked row to onSessionClick', async () => {
    const onSessionClick = jest.fn();
    render(<SessionsListV1 timeRange={RANGE} onSessionClick={onSessionClick} />);
    fireEvent.click(await screen.findByText('frames-f…'));
    expect(onSessionClick).toHaveBeenCalledWith('frames-fixture-0001');
    expect(push).not.toHaveBeenCalled();
  });

  it("links out to ouo's Session page by default, keeping range and scope", async () => {
    render(<SessionsListV1 timeRange={RANGE} project="shop" />);
    fireEvent.click(await screen.findByText('frames-f…'));
    expect(push).toHaveBeenCalledWith(
      `/a/ouo11y-rum-app/sessions/frames-fixture-0001?from=${encodeURIComponent(RANGE.from)}&to=${encodeURIComponent(RANGE.to)}&project=shop`
    );
  });

  it('refetches when a filter prop changes', async () => {
    const { rerender } = render(<SessionsListV1 timeRange={RANGE} filters={{ status: 'errored' }} />);
    await screen.findByText('frames-f…');
    rerender(<SessionsListV1 timeRange={RANGE} filters={{ status: 'crashed' }} />);
    await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'crashed', limit: 100 }));
  });
});

describe('ouo11y-rum-app/overview-health/v1', () => {
  it('renders the health tiles per platform for the range and scope from props', async () => {
    // Every Grafana page, a host plugin's included, renders inside Grafana's router.
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <OverviewHealthV1 timeRange={RANGE} project="shop" />
      </MemoryRouter>
    );
    const web = await screen.findByTestId('platform-web');
    expect(web).toHaveTextContent('4 sessions');
    expect(screen.getByTestId('platform-mobile')).toHaveTextContent('2 sessions');
    expect(api.health).toHaveBeenCalledWith(expect.objectContaining(RANGE));
    expect(screen.queryByTestId('plugin-page')).toBeNull();
  });
});
