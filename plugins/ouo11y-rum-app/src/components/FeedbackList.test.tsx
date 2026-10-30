import { stepText } from './FeedbackList';

describe('stepText', () => {
  it('a recorded step reads as the step, with a word before it where the body alone is not one', () => {
    expect(stepText({ ts: 1, name: 'ui.tap', body: 'Tap pay (button) on Cart' })).toEqual({
      title: 'Tap pay (button) on Cart',
      detail: '',
    });
    expect(stepText({ ts: 1, name: 'log', body: 'payment retried' })).toEqual({ title: 'payment retried', detail: '' });
    expect(stepText({ ts: 1, name: 'navigation', body: '/Cart' })).toEqual({ title: 'Navigation', detail: '/Cart' });
    expect(stepText({ ts: 1, name: 'ouo.screen.display', body: '' })).toEqual({
      title: 'Screen displayed',
      detail: '',
    });
    expect(stepText({ ts: 1, name: 'cart.added', body: '' })).toEqual({ title: 'cart.added', detail: '' });
  });

  it('a timeline step reads as the Timeline shows it', () => {
    const event = {
      ts: '2026-10-30T10:00:00Z',
      type: 'navigation',
      name: 'navigation',
      attrs: { url_path: '/Cart', ouo_navigation_kind: 'screen' },
    };
    expect(stepText({ ts: 1, name: 'navigation', body: '', event })).toEqual({
      title: 'Navigation (screen)',
      detail: '/Cart',
    });
  });
});
