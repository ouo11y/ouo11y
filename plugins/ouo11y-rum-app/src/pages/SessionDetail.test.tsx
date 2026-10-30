import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  vitals: jest.fn(),
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
    {
      ts: iso(sessionStart),
      type: 'session.start',
      name: 'session.start',
      attrs: { session_previous_id: '9BAB4E51-ECE2-F22B-0B64-B66437AEE24B' },
    },
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
    expect(screen.getByTestId('session-previous')).toHaveAttribute(
      'href',
      '/a/ouo11y-rum-app/sessions/9BAB4E51-ECE2-F22B-0B64-B66437AEE24B?from=now-7d&to=now'
    );
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

  it('lists a feedback beside the replay with its contact and steps; the seek shows the screen at its time (C10)', async () => {
    const at = frames.started_at + 1500;
    api.session.mockResolvedValue({
      ...detail,
      timeline: [
        ...detail.timeline,
        {
          ts: iso(at),
          type: 'custom',
          name: 'feedback',
          attrs: {
            ouo_feedback_message: 'The coupon does not apply',
            ouo_feedback_contact: 'ana@example.com',
            ouo_feedback_screenshot: 'true',
            ouo_last_events: JSON.stringify([{ ts: at - 200, name: 'ui.tap', body: 'Tap apply-coupon (button) on Cart' }]),
          },
        },
      ],
    });
    renderPage();
    const list = await screen.findByTestId('feedback-list');
    expect(within(screen.getByTestId('panel-replay')).getByTestId('feedback-list')).toBe(list);
    expect(within(list).getByTestId('feedback-message')).toHaveTextContent('The coupon does not apply');
    expect(within(list).getByTestId('feedback-contact')).toHaveTextContent('ana@example.com');
    expect(within(list).getByText('replay recording')).toBeInTheDocument();
    expect(within(list).getByTestId('feedback-step')).toHaveTextContent('Tap apply-coupon (button) on Cart');
    expect(within(list).getByTestId('feedback-step')).toHaveTextContent('+1.6s'); // 0.3 s session lead + 1.5 s - 0.2 s
    // jsdom has no scrollIntoView; the seek brings the replay into view.
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    fireEvent.click(within(list).getByTestId('feedback-seek'));
    expect(scroll).toHaveBeenCalled();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    // The replay at the feedback time (+1.5 s into the replay), on the session clock.
    expect(screen.getByTestId('frame-time')).toHaveTextContent('+1.8s');
    expect(screen.getAllByTestId('activity-item').some((r) => r.textContent?.includes('Feedback'))).toBe(true);
  });

  it('shows no feedback list without feedback', async () => {
    renderPage();
    await screen.findByTestId('replay-activity');
    expect(screen.queryByTestId('feedback-list')).toBeNull();
  });

  it('shows no vitals row and asks for no vitals without vital records', async () => {
    api.vitals.mockClear();
    renderPage();
    await screen.findByTestId('replay-activity');
    expect(screen.queryByTestId('session-vitals')).toBeNull();
    expect(api.vitals).not.toHaveBeenCalled();
  });

  it('shows the mobile vitals in the header and the activity list (mobile vitals spec section 8)', async () => {
    const at = iso(frames.started_at + 1000);
    api.session.mockResolvedValue({
      ...detail,
      app_start_ms: 3060.7,
      app_start_type: 'cold',
      timeline: [
        ...detail.timeline,
        {
          ts: at,
          type: 'vital',
          name: 'ouo.app.start',
          attrs: { ouo_app_start_type: 'cold', ouo_app_start_duration_ms: '3060.7' },
        },
        {
          ts: at,
          type: 'vital',
          name: 'app.jank',
          attrs: { app_jank_frame_count: '5', ouo_frames_total: '120', ouo_frames_slow: '4', ouo_frames_frozen: '1' },
        },
      ],
    });
    api.vitals.mockResolvedValue({
      session_id: detail.session_id,
      summary: {
        app_start: { type: 'cold', duration_ms: 3060.7, rating: 'needs-improvement' },
        frames: { total: 120, slow: 4, frozen: 1, slow_ratio: 0.0333 },
      },
      vitals: [],
    });
    renderPage();
    const row = await screen.findByTestId('session-vitals');
    expect(within(row).getByTestId('vital-app_start')).toHaveTextContent('Cold start 3.06 s');
    expect(within(row).getByTestId('vital-app_start')).toHaveAttribute('data-rating', 'needs-improvement');
    expect(within(row).getByTestId('vital-frames')).toHaveAttribute('data-rating', 'poor');
    expect(within(row).queryByTestId('vital-ttid')).toBeNull();
    expect(api.vitals).toHaveBeenCalledWith(detail.session_id, { from: 'now-7d', to: 'now' });
    const list = screen.getByTestId('replay-activity');
    expect(within(list).getByText('App start (cold) 3.06 s')).toBeInTheDocument();
    expect(within(list).getByText('Janky frames 5 / 120 (1 frozen)')).toBeInTheDocument();
  });
});
