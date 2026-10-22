import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { LogLine, LogsResponse } from '../api/types';
import { filterLogs, LogsPanel, visibleAttrs } from './LogsPanel';

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

const start = Date.parse('2026-10-14T00:32:49Z');

function line(over: Partial<LogLine> & { body: string }): LogLine {
  return {
    ts: '2026-10-14T00:33:29.300Z',
    service: 'sentry-demo',
    level: 'info',
    source: 'session',
    attrs: {},
    ...over,
  };
}

const data: LogsResponse = {
  session_id: 's1',
  logs: [
    line({ body: 'checkout started with 2 lines' }),
    line({
      body: 'request',
      service: 'demo-backend',
      source: 'trace',
      ts: '2026-10-14T00:33:29.310Z',
      trace_url: 'http://g/explore?t',
    }),
    line({ body: 'payment failed: HTTP 500', level: 'error', ts: '2026-10-14T00:33:32.600Z' }),
  ],
  count: 3,
  truncated: false,
  trace_count: 26,
  query: '{service_name=~".+"} | session_id="s1"',
  explore_url: 'http://g/explore?loki',
};

describe('filterLogs', () => {
  it('filters by source and text', () => {
    expect(filterLogs(data.logs, 'trace', '').map((l) => l.body)).toEqual(['request']);
    expect(filterLogs(data.logs, 'session', '').length).toBe(2);
    expect(filterLogs(data.logs, 'all', 'PAYMENT').map((l) => l.body)).toEqual(['payment failed: HTTP 500']);
    expect(filterLogs(data.logs, 'all', 'demo-backend').length).toBe(1);
    expect(filterLogs(data.logs, 'all', 'error').length).toBe(1);
  });
});

describe('visibleAttrs', () => {
  it('keeps the app and backend attributes, drops ouo and SDK internals', () => {
    expect(
      visibleAttrs({
        http_route: '/api/checkout',
        http_response_status_code: '500',
        duration_ms: '11',
        flags: '1',
        ouo_project_id: 'demo',
        ouo_sentry_session_match: 'replay',
        exception_stacktrace: 'Error\n at x',
        payment_method: 'broken-card',
      })
    ).toEqual([
      'duration_ms=11',
      'http_response_status_code=500',
      'http_route=/api/checkout',
      'payment_method=broken-card',
    ]);
  });
});

describe('LogsPanel', () => {
  it('lists lines with relative time, level and service, and seeks on click', () => {
    const onSeek = jest.fn();
    render(<LogsPanel data={data} sessionStart={start} onSeek={onSeek} />);
    const rows = within(screen.getByTestId('logs')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('+43.6s');
    expect(rows[2]).toHaveTextContent('ERROR');
    expect(rows[1]).toHaveTextContent('demo-backend');
    fireEvent.click(rows[2]);
    expect(onSeek).toHaveBeenCalledWith(Date.parse('2026-10-14T00:33:32.600Z'));
    expect(screen.getByRole('link', { name: /open in explore/i })).toHaveAttribute('href', 'http://g/explore?loki');
  });

  it('switches to the lines of other services and filters by text', () => {
    render(<LogsPanel data={data} sessionStart={start} />);
    fireEvent.click(screen.getByLabelText(/Same traces \(1\)/));
    expect(within(screen.getByTestId('logs')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText(/All \(3\)/));
    fireEvent.change(screen.getByLabelText('Filter logs'), { target: { value: 'nothing like this' } });
    expect(screen.getByText('No line matches the filter.')).toBeInTheDocument();
  });

  it('says when Tempo was not searched', () => {
    render(<LogsPanel data={{ ...data, trace_count: -1 }} sessionStart={start} />);
    expect(screen.getByText(/Tempo could not be searched/)).toBeInTheDocument();
  });
});

describe('LogsPanel exception lines (C7)', () => {
  it('shows type and message with an expandable stack, not the record metadata', () => {
    const exc = line({
      body: 'exception',
      level: 'error',
      service: 'sentry-demo-ouo',
      event_name: 'exception',
      attrs: {
        exception_type: 'Error',
        exception_message: 'sentry-demo handled error: coupon service unavailable',
        exception_stacktrace: 'Error: coupon\n    at handledError (app:///main.jsbundle:1:10)',
        session_previous_id: '4878b16e-e455-40d9-8b77-9a4d43a1b3d8',
        demo_action: 'handled-error',
        network_connection_type: 'wifi',
      },
    });
    render(<LogsPanel data={{ ...data, logs: [exc], count: 1 }} sessionStart={start} />);
    const body = screen.getByTestId('log-body');
    expect(body).toHaveTextContent('Error: sentry-demo handled error: coupon service unavailable');
    expect(body).toHaveTextContent('demo_action=handled-error');
    expect(body).not.toHaveTextContent('session_previous_id');
    expect(body).not.toHaveTextContent('network_connection_type');
    fireEvent.click(within(body).getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at handledError');
  });

  it('finds exception lines by their message', () => {
    const exc = line({ body: 'exception', event_name: 'exception', attrs: { exception_message: 'coupon down' } });
    expect(filterLogs([exc], 'all', 'coupon')).toHaveLength(1);
  });
});
