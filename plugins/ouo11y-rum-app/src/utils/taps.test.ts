import type { TimelineEvent } from '../api/types';
import { buildTaps, gestureTitle, tapLabel, tapSubject, visibleTaps } from './taps';

const start = 1_791_946_506_794;
const tapEvent = (offsetMs: number, target: string, path = `${target} > Text`): TimelineEvent => ({
  ts: new Date(start + offsetMs).toISOString(),
  type: 'custom',
  name: 'ui.tap',
  attrs: { ouo_ui_target: target, ouo_ui_path: path },
});
const other: TimelineEvent = { ts: new Date(start).toISOString(), type: 'navigation', name: 'navigation', attrs: {} };

describe('user steps (spec C6)', () => {
  it('names the gesture, else a swipe from the recorded touch', () => {
    expect([
      gestureTitle('long_press'),
      gestureTitle('swipe'),
      gestureTitle('tap', true),
      gestureTitle(undefined, true),
      gestureTitle(),
    ]).toEqual(['Long press', 'Swipe', 'Tap', 'Swipe', 'Tap']);
  });

  it('says what was touched and where, without repeating a view type that is the target', () => {
    expect(tapSubject('add-to-cart', 'button', 'Product')).toBe('add-to-cart (button) on Product');
    expect(tapSubject('button', 'button', 'Cart')).toBe('button on Cart');
    expect(tapSubject('checkout-pay')).toBe('checkout-pay');
  });

  it('carries gesture, view type and screen from the ui.tap event', () => {
    const ev = {
      ...tapEvent(100, 'cart-items'),
      attrs: {
        ouo_ui_target: 'cart-items',
        ouo_ui_gesture: 'swipe',
        ouo_ui_view_type: 'FlatList',
        app_screen_name: 'Cart',
      },
    };
    expect(buildTaps([], [ev])[0]).toMatchObject({
      target: 'cart-items',
      gesture: 'swipe',
      viewType: 'FlatList',
      screen: 'Cart',
    });
  });
});

describe('buildTaps', () => {
  it('pairs each ui.tap breadcrumb with the touch that started just before it', () => {
    // Measured on the simulator: began/ended 1 ms apart, the breadcrumb about 90 ms after the start.
    const taps = buildTaps(
      [
        { ts: start + 12_781, x: 201, y: 418, phase: 'began' },
        { ts: start + 12_782, x: 201, y: 418, phase: 'ended' },
        { ts: start + 19_200, x: 120, y: 300, phase: 'began' },
        { ts: start + 19_210, x: 120, y: 300, phase: 'ended' },
      ],
      [other, tapEvent(12_869, 'action-browse-catalog'), tapEvent(19_290, 'product-p-1001')]
    );
    expect(taps).toEqual([
      {
        ts: start + 12_781,
        x: 201,
        y: 418,
        drag: false,
        target: 'action-browse-catalog',
        path: 'action-browse-catalog > Text',
        timelineIndex: 1,
      },
      {
        ts: start + 19_200,
        x: 120,
        y: 300,
        drag: false,
        target: 'product-p-1001',
        path: 'product-p-1001 > Text',
        timelineIndex: 2,
      },
    ]);
  });

  it('keeps a breadcrumb without a touch and a touch without a breadcrumb', () => {
    const taps = buildTaps(
      [
        { ts: start + 1000, x: 10, y: 20, phase: 'began' },
        { ts: start + 1005, x: 10, y: 20, phase: 'ended' },
      ],
      [tapEvent(5000, 'btn-Checkout')]
    );
    expect(taps).toHaveLength(2);
    expect(taps[0]).toMatchObject({ ts: start + 1000, x: 10, y: 20 });
    expect(taps[0].target).toBeUndefined();
    expect(taps[1]).toEqual({
      ts: start + 5000,
      target: 'btn-Checkout',
      path: 'btn-Checkout > Text',
      timelineIndex: 0,
    });
  });

  it('pairs a breadcrumb at most once and only within the match window', () => {
    const taps = buildTaps(
      [{ ts: start + 1000, x: 1, y: 1, phase: 'began' }],
      [tapEvent(1050, 'a'), tapEvent(1080, 'b'), tapEvent(3000, 'c')]
    );
    expect(taps.map((t) => [t.target, t.x])).toEqual([
      ['a', 1],
      ['b', undefined],
      ['c', undefined],
    ]);
  });

  it('marks a gesture that moved as a drag and groups its moves', () => {
    const taps = buildTaps(
      [
        { ts: start + 100, x: 300, y: 700, phase: 'began' },
        { ts: start + 120, x: 300, y: 690, phase: 'moved' },
        { ts: start + 780, x: 300, y: 400, phase: 'moved' },
        { ts: start + 790, x: 300, y: 400, phase: 'ended' },
      ],
      []
    );
    expect(taps).toEqual([{ ts: start + 100, x: 300, y: 700, drag: true }]);
    expect(tapLabel(taps[0])).toBe('Swipe at 300, 700');
  });
});

describe('visibleTaps', () => {
  const vp = { width: 400, height: 800 };
  it('holds a tap fully visible for 1 s and fades it out by 1.5 s', () => {
    const taps = [{ ts: 1000, x: 200, y: 200 }];
    expect(visibleTaps(taps, vp, 999)).toEqual([]);
    expect(visibleTaps(taps, vp, 1000)[0]).toMatchObject({ left: 0.5, top: 0.25, opacity: 1 });
    expect(visibleTaps(taps, vp, 2000)[0].opacity).toBe(1);
    expect(visibleTaps(taps, vp, 2250)[0].opacity).toBeCloseTo(0.5);
    expect(visibleTaps(taps, vp, 2501)).toEqual([]);
  });
  it('shows taps without a usable position as unplaced', () => {
    const shown = visibleTaps(
      [
        { ts: 0, target: 'x' },
        { ts: 0, x: 900, y: 10 },
      ],
      vp,
      10
    );
    expect(shown).toHaveLength(2);
    expect(shown.every((v) => v.left === undefined)).toBe(true);
  });
});
