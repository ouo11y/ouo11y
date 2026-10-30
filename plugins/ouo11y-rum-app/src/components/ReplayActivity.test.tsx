import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TimelineEvent } from '../api/types';
import { buildActivity } from '../utils/activity';
import { ReplayActivity } from './ReplayActivity';

const start = 1_791_946_506_794;
const ev = (offsetMs: number, type: string, name = type, attrs: Record<string, string> = {}): TimelineEvent => ({
  ts: new Date(start + offsetMs).toISOString(),
  type,
  name,
  attrs,
});

const items = buildActivity(
  [
    ev(1000, 'navigation', 'navigation', { url_path: '/catalog' }),
    ev(2050, 'custom', 'ui.tap', {
      ouo_ui_target: 'btn-Add to cart',
      ouo_ui_view_type: 'button',
      app_screen_name: 'Product',
    }),
    ev(4000, 'exception', 'exception', { exception_type: 'TypeError', exception_message: 'boom' }),
  ],
  start,
  [
    {
      ts: start + 2000,
      x: 201,
      y: 418,
      target: 'btn-Add to cart',
      path: 'btn-Add to cart > Text',
      viewType: 'button',
      screen: 'Product',
      timelineIndex: 1,
    },
    { ts: start + 3000, x: 10, y: 20 },
  ]
);

describe('ReplayActivity', () => {
  beforeEach(() => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists taps with target and position and seeks on click', () => {
    const onSeek = jest.fn();
    render(<ReplayActivity items={items} durationMs={10_000} currentMs={2500} onSeek={onSeek} />);
    const rows = screen.getAllByTestId('activity-item');
    expect(rows.map((r) => r.getAttribute('data-category'))).toEqual(['navigation', 'tap', 'tap', 'error']);
    expect(rows[1]).toHaveTextContent('Tap btn-Add to cart (button) on Product');
    expect(rows[1]).toHaveTextContent('at 201, 418');
    expect(rows[2]).toHaveTextContent('Tap');
    expect(rows[1]).toHaveAttribute('data-active', 'true');
    fireEvent.click(rows[3]);
    expect(onSeek).toHaveBeenCalledWith(4000, items[3]);
  });

  it('filters to taps and by text', () => {
    render(<ReplayActivity items={items} durationMs={10_000} currentMs={0} onSeek={jest.fn()} />);
    expect(screen.getByTestId('activity-filter-tap')).toHaveTextContent('Taps 2');
    fireEvent.click(screen.getByTestId('activity-filter-tap'));
    expect(screen.getAllByTestId('activity-item')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'cart' } });
    expect(screen.getAllByTestId('activity-item')).toHaveLength(1);
    expect(screen.getByTestId('activity-filter-network')).toBeDisabled();
  });

  it('shows times on the session clock when given its start (F4), and is read-only without a replay', () => {
    render(<ReplayActivity items={items} durationMs={0} currentMs={-1} clockStart={start - 300} />);
    const rows = screen.getAllByTestId('activity-item');
    expect(rows[0]).toHaveTextContent('+1.3s');
    expect(rows[0]).not.toHaveAttribute('data-active');
    fireEvent.click(rows[0]); // no onSeek: nothing to call, nothing thrown
  });

  it('expands the stack of an error row without seeking (C1)', () => {
    const onSeek = jest.fn();
    const withStack = buildActivity(
      [
        ev(4000, 'exception', 'exception', {
          exception_type: 'TypeError',
          exception_message: 'boom',
          exception_stacktrace: 'TypeError: boom\n    at f (a.js:1:2)',
        }),
      ],
      start
    );
    render(<ReplayActivity items={withStack} durationMs={10_000} currentMs={0} onSeek={onSeek} />);
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at f (a.js:1:2)');
    expect(onSeek).not.toHaveBeenCalled();
  });
});
