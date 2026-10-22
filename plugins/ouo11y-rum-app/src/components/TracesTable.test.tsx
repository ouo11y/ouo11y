import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TraceSummary } from '../api/types';
import { TracesTable } from './TracesTable';

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

const trace = (root_name: string, root_url_path?: string): TraceSummary => ({
  trace_id: `${root_name}${root_url_path ?? ''}`.replace(/\W/g, '').padEnd(32, '0'),
  root_name,
  root_url_path,
  root_service: 'sentry-demo-ouo',
  start: '2026-10-22T22:01:30Z',
  duration_ms: 12,
  span_count: 3,
  has_error: false,
  grafana_url: 'http://g/explore',
});

describe('TracesTable (C6)', () => {
  it('names generic HTTP roots by method and url.path, and keeps the raw name as the tooltip', () => {
    render(
      <TracesTable
        traces={[trace('HTTP GET', '/api/products/p-1001'), trace('HTTP POST'), trace('GET /api/cart', '/x')]}
      />
    );
    const names = screen.getAllByTestId('trace-name');
    expect(names.map((n) => n.textContent)).toEqual(['GET /api/products/p-1001', 'HTTP POST', 'GET /api/cart']);
    expect(names[0]).toHaveAttribute('title', 'HTTP GET');
  });
});
