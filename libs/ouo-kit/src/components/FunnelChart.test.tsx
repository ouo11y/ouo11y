import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FunnelReport } from '../api';
import { FunnelChart } from './FunnelChart';

const report: FunnelReport = {
  funnel: { id: 'shop', name: 'Shop', steps: [] },
  from: 0,
  to: 1,
  truncated: false,
  steps: [
    { step: { kind: 'page', value: '/products', label: 'Browse' }, sessions: 10, by_platform: { web: 6, ios: 4 }, conversion_from_first: 100, conversion_from_previous: 0, dropped_off: 0, failed: 0, failure_rate: 0, median_ms: null, p75_ms: null },
    { step: { kind: 'event', value: 'payment.submit', label: 'Pay' }, sessions: 4, by_platform: { web: 3, ios: 1 }, conversion_from_first: 40, conversion_from_previous: 40, dropped_off: 6, failed: 2, failure_rate: 20, median_ms: 3000, p75_ms: 4000 },
  ],
};

describe('FunnelChart', () => {
  it('shows each step, the platforms and the failed and abandoned parts of a drop-off', () => {
    const html = renderToStaticMarkup(<FunnelChart report={report} onDropOff={() => undefined} />);
    expect(html).toContain('1. Browse');
    expect(html).toContain('2. Pay');
    expect(html).toContain('ios 4');
    expect(html).toContain('6 dropped');
    expect(html).toContain('2 failed (20 %)');
    expect(html).toContain('4 abandoned');
    expect(html).toContain('median 3s');
  });

  it('renders drop-offs as text without a click handler', () => {
    const html = renderToStaticMarkup(<FunnelChart report={report} />);
    expect(html).not.toContain('<button');
  });
});
