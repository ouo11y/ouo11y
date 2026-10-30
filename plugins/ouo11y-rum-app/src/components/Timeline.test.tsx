import { eventLook } from './Timeline';
import type { TimelineEvent } from '../api/types';

const ev = (name: string, attrs: Record<string, string>, type = 'custom'): TimelineEvent => ({
  ts: '2026-10-14T10:00:00Z',
  type,
  name,
  attrs,
});

describe('eventLook', () => {
  it('titles the events the Sentry bridge derives', () => {
    const log = ev('log', { message: 'payment failed: HTTP 500', ouo_sentry_level: 'error' });
    expect(eventLook(log).title(log)).toBe('Log (error)');
    expect(eventLook(log).detail(log)).toBe('payment failed: HTTP 500');

    const req = ev('http.request', {
      http_request_method: 'GET',
      url_full: 'http://localhost:8084/api/cart',
      http_response_status_code: '200',
    });
    expect(eventLook(req).title(req)).toBe('Request 200');
    expect(eventLook(req).detail(req)).toBe('GET http://localhost:8084/api/cart');

    const app = ev('app.lifecycle', { ouo_app_state: 'background' });
    expect(eventLook(app).title(app)).toBe('App background');

    const crumb = ev('breadcrumb', {
      ouo_breadcrumb_category: 'demo',
      message: 'promo opened',
      ouo_breadcrumb_data_promo: 'AUTUMN',
    });
    expect(eventLook(crumb).title(crumb)).toBe('demo');
    expect(eventLook(crumb).detail(crumb)).toBe('promo opened promo=AUTUMN');
  });

  it('reads a tap as a user step: gesture, target, view type, screen (spec C6)', () => {
    const step = ev('ui.tap', {
      ouo_ui_target: 'add-to-cart',
      ouo_ui_view_type: 'button',
      ouo_ui_gesture: 'long_press',
      app_screen_name: 'Product',
    });
    expect(eventLook(step).title(step)).toBe('Long press');
    expect(eventLook(step).detail(step)).toBe('add-to-cart (button) on Product');
    // The Sentry bridge's taps carry the target only; labels off, the target is the view type.
    const bridge = ev('ui.tap', { ouo_ui_target: 'checkout-pay' });
    expect([eventLook(bridge).title(bridge), eventLook(bridge).detail(bridge)]).toEqual(['Tap', 'checkout-pay']);
    const unlabelled = ev('ui.tap', { ouo_ui_target: 'button', ouo_ui_view_type: 'button', ouo_ui_gesture: 'swipe' });
    expect([eventLook(unlabelled).title(unlabelled), eventLook(unlabelled).detail(unlabelled)]).toEqual([
      'Swipe',
      'button',
    ]);
  });

  it('keeps the generic look for other custom events and the typed looks', () => {
    const custom = ev('cart.added', { sku: 'sku-1' });
    expect(eventLook(custom).title(custom)).toBe('cart.added');
    expect(eventLook(custom).detail(custom)).toBe('sku=sku-1');

    // A web SDK event named like a bridge event but typed by rum-api keeps its type's look.
    const nav = ev('navigation', { url_path: '/cart' }, 'navigation');
    expect(eventLook(nav).detail(nav)).toBe('/cart');
  });

  it('titles mobile vitals and colours them by rating', () => {
    const theme = {
      colors: {
        success: { main: 'green' },
        warning: { main: 'orange' },
        error: { main: 'red' },
        text: { secondary: 'grey' },
      },
    };
    const start = ev('ouo.app.start', { ouo_app_start_type: 'cold', ouo_app_start_duration_ms: '1500' }, 'vital');
    expect(eventLook(start).title(start)).toBe('App start (cold) 1.50 s');
    expect(eventLook(start).color(theme as never)).toBe('green');
    const screen = ev('ouo.screen.display', { app_screen_name: 'Home', ouo_screen_ttid_ms: '3316.2' }, 'vital');
    expect(eventLook(screen).title(screen)).toBe('Home displayed in 3.32 s');
    expect(eventLook(screen).color(theme as never)).toBe('red');
    const stall = ev(
      'ouo.stall',
      { ouo_stall_count: '2', ouo_stall_total_ms: '340', ouo_stall_longest_ms: '220' },
      'vital'
    );
    expect(eventLook(stall).title(stall)).toBe('2 JS stalls, longest 220 ms');
    expect(eventLook(stall).color(theme as never)).toBe('orange');
  });
});
