import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionRecord } from '../api/types';
import Sessions, { sessionHref } from './Sessions';

let mockSearch = 'from=now-1h&to=now';
const mockPush = jest.fn();
jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => new URLSearchParams(mockSearch),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: () => undefined,
    push: (...a: unknown[]) => mockPush(...a),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const mockSessions = jest.fn();
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: { sessions: (...a: unknown[]) => mockSessions(...a), projects: () => Promise.resolve({ projects: [] }) },
}));

const rec: SessionRecord = {
  session_id: 'shop-web-1',
  user_id: 'u1',
  project_id: 'shop',
  platform: 'web',
  service_name: 'shop-web',
  service_version: '1.0.0',
  started_at: '2026-11-04T10:00:00Z',
  last_signal_at: '2026-11-04T10:01:00Z',
  ended_at: null,
  end_reason: null,
  state: 'active',
  status: 'healthy',
  error_count: 0,
  crash_count: 0,
  failed_request_count: 0,
  event_count: 2,
  trace_count: 0,
  has_replay: false,
};

describe('Sessions scope', () => {
  beforeEach(() => mockSessions.mockReset().mockResolvedValue({ sessions: [rec], count: 1, from: '', to: '' }));

  it('passes the URL scope to rum-api and shows each session project', async () => {
    mockSearch = 'from=now-1h&to=now&project=shop&service=shop-web&status=healthy';
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Sessions />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(mockSessions).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'now-1h', to: 'now', project: 'shop', service: 'shop-web', status: 'healthy' })
      )
    );
    expect(await screen.findByTestId('session-project')).toHaveTextContent('shop');
    // The shared app selector replaced the free-text Service filter.
    expect(screen.queryByPlaceholderText('any service')).toBeNull();
  });

  it('sends no scope for all projects', async () => {
    mockSearch = 'from=now-1h&to=now';
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Sessions />
      </MemoryRouter>
    );
    await waitFor(() => expect(mockSessions).toHaveBeenCalled());
    const arg = mockSessions.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.project).toBeUndefined();
    expect(arg.service).toBeUndefined();
  });

  it('keeps the scope in session links', () => {
    expect(sessionHref('s/1', { from: 'now-1h', to: 'now' }, { project: 'shop', service: '' })).toBe(
      '/a/ouo11y-rum-app/sessions/s%2F1?from=now-1h&to=now&project=shop'
    );
    expect(sessionHref('s1', { from: 'now-1h', to: 'now' })).toBe('/a/ouo11y-rum-app/sessions/s1?from=now-1h&to=now');
  });
});
