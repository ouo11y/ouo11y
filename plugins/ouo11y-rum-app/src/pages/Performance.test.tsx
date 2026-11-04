import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InteractionGroupsResponse } from '../api/vitals';
import Performance from './Performance';

let search = new URLSearchParams();
const partial = jest.fn();

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => search,
    getLocation: () => ({ pathname: '/a/ouo11y-rum-app/performance' }),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: (...a: unknown[]) => partial(...a),
    replace: jest.fn(),
    push: jest.fn(),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const slowestInteractions = jest.fn();
jest.mock('../api/vitals', () => ({ slowestInteractions: (...a: unknown[]) => slowestInteractions(...a) }));

const response: InteractionGroupsResponse = {
  groups: [
    {
      target: 'button#save',
      page: '/patients/:id',
      interaction_type: 'pointer',
      count: 4,
      sessions: 3,
      p75_ms: 480,
      max_ms: 620,
      rating: 'needs-improvement',
      input_delay_p75_ms: 8,
      processing_duration_p75_ms: 440,
      presentation_delay_p75_ms: 30,
      script: { invoker: 'BUTTON#save.onclick', count: 4 },
    },
  ],
  total: 7,
  page_views: 21,
  from: '2026-11-03T10:00:00Z',
  to: '2026-11-04T10:00:00Z',
};

beforeEach(() => {
  search = new URLSearchParams();
  partial.mockReset();
  slowestInteractions.mockReset();
});

describe('Performance page', () => {
  it('asks rum-api for the web INP groups of the range and filters, and shows the table', async () => {
    search = new URLSearchParams('service=web-store&page=/patients/:id&from=now-7d&to=now');
    slowestInteractions.mockResolvedValue(response);
    render(<Performance />);
    expect(await screen.findByText('button#save')).toBeInTheDocument();
    expect(slowestInteractions).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'now-7d',
        to: 'now',
        platform: 'web',
        service: 'web-store',
        page: '/patients/:id',
      })
    );
    expect(screen.getByText(/21 page views with an interaction, 7 elements, the slowest 1 shown/)).toBeInTheDocument();
  });

  it('commits a filter to the URL on Enter', async () => {
    slowestInteractions.mockResolvedValue(response);
    render(<Performance />);
    await screen.findByText('button#save');
    const input = screen.getByLabelText('release');
    fireEvent.change(input, { target: { value: '1.4.0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(partial).toHaveBeenCalledWith(expect.objectContaining({ release: '1.4.0' }), true);
  });

  it('says so when there is no INP in the range', async () => {
    slowestInteractions.mockResolvedValue({ ...response, groups: [], total: 0, page_views: 0 });
    render(<Performance />);
    expect(await screen.findByText('No INP in this range')).toBeInTheDocument();
  });
});
