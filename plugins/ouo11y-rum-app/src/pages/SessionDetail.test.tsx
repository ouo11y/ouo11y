import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import framesFixture from '../__fixtures__/frames.json';
import type { ReplayFramesResponse, SessionDetail as Detail } from '../api/types';
import { FeatureTogglesContext, type FeatureToggles } from '../featureToggles';
import SessionDetail from './SessionDetail';

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => new URLSearchParams('from=now-7d&to=now'),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: () => undefined,
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
// The session starts 300 ms before the replay (the clock check) and the first screen 2 s before it (C4).
const sessionStart = frames.started_at - 300;
const iso = (ms: number) => new Date(ms).toISOString();
const STACK = 'Error: coupon service unavailable\n    at handledError (app:///main.jsbundle:1:10)';

const detail: Detail = {
  session_id: 'frames-fixture-0001',
  user_id: null,
  platform: 'mobile',
  service_name: 'sentry-demo-ouo',
  service_version: '1.4.0',
  started_at: iso(sessionStart),
  last_signal_at: iso(frames.ended_at),
  ended_at: iso(frames.ended_at),
  end_reason: 'background',
  state: 'ended',
  status: 'errored',
  error_count: 1,
  crash_count: 0,
  failed_request_count: 0,
  event_count: 3,
  trace_count: 0,
  has_replay: true,
  replay_kind: 'frames',
  context: {
    os_name: 'iOS',
    os_version: '27.0',
    device_model_identifier: 'iPhone19,2',
    deployment_environment_name: 'staging',
  },
  timeline: [
    { ts: iso(sessionStart - 2000), type: 'navigation', name: 'navigation', attrs: { url_path: 'Home' } },
    { ts: iso(sessionStart), type: 'session.start', name: 'session.start', attrs: {} },
    {
      ts: iso(frames.started_at + 4000),
      type: 'exception',
      name: 'exception',
      attrs: { exception_type: 'Error', exception_message: 'coupon service unavailable', exception_stacktrace: STACK },
    },
  ],
  traces: [],
};

function renderPage(toggles: FeatureToggles = {}) {
  return render(
    <FeatureTogglesContext.Provider value={toggles}>
      <MemoryRouter
        initialEntries={['/sessions/frames-fixture-0001']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
      </MemoryRouter>
    </FeatureTogglesContext.Provider>
  );
}

describe('SessionDetail', () => {
  beforeEach(() => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    api.session.mockResolvedValue(detail);
    api.logs.mockResolvedValue({
      session_id: detail.session_id,
      logs: [],
      count: 0,
      truncated: false,
      trace_count: 0,
      query: '',
    });
    api.replayMeta.mockResolvedValue({ session_id: detail.session_id, kind: 'frames', masked: true, chunks: [] });
    api.replayFrames.mockResolvedValue(frames);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows only the activity list beside the player by default (B1), with device, OS and environment (C2)', async () => {
    renderPage();
    const activity = await screen.findByTestId('replay-activity');
    expect(screen.queryByTestId('panel-timeline')).toBeNull();
    expect(within(screen.getByTestId('panel-replay')).getByTestId('replay-activity')).toBe(activity);
    expect(screen.getByTestId('session-device')).toHaveTextContent('iPhone19,2');
    expect(screen.getByTestId('session-os')).toHaveTextContent('iOS 27.0');
    expect(screen.getByTestId('session-environment')).toHaveTextContent('staging');
  });

  it('shows the Timeline panel with the sessionTimelinePanel toggle on (B1)', async () => {
    renderPage({ sessionTimelinePanel: true });
    expect(await screen.findByTestId('panel-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('replay-activity')).toBeInTheDocument();
  });

  it('counts the touches of a frames replay as taps (C3) and shows the real masking state (C8)', async () => {
    renderPage();
    const taps = await screen.findByTestId('activity-filter-tap');
    expect(taps).toHaveTextContent('Taps 2');
    expect(screen.getByTestId('replay-masking')).toHaveAttribute('data-masking', 'masked');
  });

  it('puts nothing before the session start (C4) and reads one clock everywhere (F4)', async () => {
    renderPage({ sessionTimelinePanel: true });
    const rows = await screen.findAllByTestId('activity-item');
    // Session start first, the early first screen moved to +0.0s, the error at the same time in both lists.
    expect(rows[0]).toHaveTextContent('Session start');
    expect(rows[0]).toHaveTextContent('+0.0s');
    expect(rows[1]).toHaveTextContent('Home');
    expect(rows[1]).toHaveTextContent('+0.0s');
    const errorRow = rows.find((r) => r.getAttribute('data-category') === 'error')!;
    expect(errorRow).toHaveTextContent('+4.3s');
    const timelineError = within(screen.getByTestId('timeline')).getByText('Error').closest('li')!;
    expect(timelineError).toHaveTextContent('+4.3s');
    // The player's label is on the same clock: the replay starts 0.3 s into the session.
    expect(screen.getByTestId('frame-time')).toHaveTextContent('+0.3s');
  });
});
