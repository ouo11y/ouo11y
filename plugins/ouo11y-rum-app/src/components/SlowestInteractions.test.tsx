import React from 'react';
import { render, screen, within } from '@testing-library/react';
import type { InteractionGroup } from '../api/vitals';
import { formatMs, scriptLabel, SlowestInteractions } from './SlowestInteractions';

export function group(over: Partial<InteractionGroup> = {}): InteractionGroup {
  return {
    target: 'button#save.btn',
    page: '/patients/:id',
    interaction_type: 'pointer',
    count: 4,
    sessions: 3,
    p75_ms: 480,
    max_ms: 620,
    rating: 'needs-improvement',
    input_delay_p75_ms: 8,
    processing_duration_p75_ms: 440.4,
    presentation_delay_p75_ms: 30,
    script: {
      invoker: 'BUTTON#save.onclick',
      invoker_type: 'event-listener',
      file: 'https://shop.example/assets/app.js?v=3',
      function: 'save',
      count: 3,
    },
    ...over,
  };
}

describe('SlowestInteractions', () => {
  it('shows one row per element and page with the p75, phases and script', () => {
    render(
      <SlowestInteractions
        groups={[
          group(),
          group({
            target: '',
            page: '/',
            p75_ms: 120,
            rating: 'good',
            script: null,
            input_delay_p75_ms: null,
            processing_duration_p75_ms: null,
            presentation_delay_p75_ms: null,
            interaction_type: undefined,
          }),
        ]}
      />
    );
    const rows = within(screen.getByTestId('slowest-interactions')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const first = within(rows[1]);
    expect(first.getByText('button#save.btn')).toBeInTheDocument();
    expect(first.getByText('/patients/:id')).toBeInTheDocument();
    expect(first.getByText('480 ms')).toHaveAttribute('data-rating', 'needs-improvement');
    expect(first.getByText('440 ms')).toBeInTheDocument();
    expect(first.getByText(/BUTTON#save\.onclick · save \(app\.js\)/)).toBeInTheDocument();
    expect(first.getByText('(3 of 4)')).toBeInTheDocument();
    const second = within(rows[2]);
    expect(second.getByText('no target sent')).toBeInTheDocument();
    expect(second.getByText('120 ms')).toHaveAttribute('data-rating', 'good');
    expect(second.getAllByText('–').length).toBeGreaterThanOrEqual(4);
  });

  it('formats durations and scripts', () => {
    expect(formatMs(12.6)).toBe('13 ms');
    expect(formatMs(null)).toBe('–');
    expect(scriptLabel(null)).toBe('–');
    expect(scriptLabel({ invoker: 'Window.setTimeout', count: 1 })).toBe('Window.setTimeout');
    expect(scriptLabel({ file: 'https://cdn.example/lib/', function: 'run', count: 1 })).toBe('run (lib)');
    expect(scriptLabel({ count: 1 })).toBe('–');
  });
});
