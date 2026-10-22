import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TimelineEvent } from '../api/types';
import { frameCount, StackTrace } from './StackTrace';
import { Timeline } from './Timeline';

const STACK = `Error: coupon service unavailable
    at handledError (app:///main.jsbundle:1:1391274)
    at onPress (app:///main.jsbundle:1:1390001)`;

describe('StackTrace (C1)', () => {
  it('is collapsed with a frame count, expands on click, and does not bubble the click', () => {
    const onRow = jest.fn();
    render(
      <div onClick={onRow}>
        <StackTrace stack={STACK} />
      </div>
    );
    expect(screen.getByTestId('stack-toggle')).toHaveTextContent('Show stack trace (2 frames)');
    expect(screen.queryByTestId('stack-trace')).toBeNull();
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at handledError (app:///main.jsbundle:1:1391274)');
    expect(onRow).not.toHaveBeenCalled();
  });

  it('renders nothing without a stack', () => {
    const { container } = render(<StackTrace stack={'  '} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts JS, Java-style and native frames', () => {
    expect(frameCount('Error\n  at a (x:1)\nb@y:2\n#0 0x1 foo')).toBe(3);
  });
});

describe('Timeline errors and clamped events', () => {
  beforeEach(() => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the stack of an exception and the recorded time of an event moved to the session start', () => {
    const start = Date.parse('2026-10-22T22:01:18.137Z');
    const timeline: TimelineEvent[] = [
      { ts: new Date(start).toISOString(), type: 'session.start', name: 'session.start', attrs: {} },
      {
        ts: new Date(start).toISOString(),
        type: 'navigation',
        name: 'navigation',
        attrs: { url_path: 'Home' },
        clampedFrom: new Date(start - 3600).toISOString(),
      },
      {
        ts: new Date(start + 49_000).toISOString(),
        type: 'exception',
        name: 'exception',
        attrs: {
          exception_type: 'Error',
          exception_message: 'coupon service unavailable',
          exception_stacktrace: STACK,
        },
      },
    ];
    render(<Timeline timeline={timeline} sessionStart={start} activeIndex={-1} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('+0.0s');
    expect(rows[1]).toHaveAttribute('data-clamped', 'true');
    expect(rows[1].getAttribute('title')).toContain('-3.6s: recorded before the session start');
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at onPress');
  });

  it('shows and seeks a tap at its touch start, the time the activity list shows (F4 one clock)', () => {
    const start = Date.parse('2026-10-16T14:22:46.171Z');
    const onSeek = jest.fn();
    const tap: TimelineEvent = {
      ts: new Date(start + 11_500).toISOString(),
      type: 'custom',
      name: 'ui.tap',
      attrs: { ouo_ui_target: 'action-browse-catalog' },
    };
    render(
      <Timeline
        timeline={[tap]}
        sessionStart={start}
        activeIndex={-1}
        onSeek={onSeek}
        tapTimes={new Map([[0, start + 11_400]])}
      />
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('+11.4s');
    fireEvent.click(row);
    expect(onSeek).toHaveBeenCalledWith(start + 11_400, tap);
  });
});
