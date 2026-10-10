import { scrollRowIntoView } from './scroll';

function fakeList(scrollTop: number, clientHeight = 100) {
  return { scrollTop, clientHeight } as unknown as HTMLElement;
}
const row = (offsetTop: number, offsetHeight = 20) => ({ offsetTop, offsetHeight }) as unknown as HTMLElement;

describe('scrollRowIntoView', () => {
  it('leaves the list alone when the row is already visible', () => {
    const list = fakeList(50);
    scrollRowIntoView(list, row(60));
    expect(list.scrollTop).toBe(50);
  });

  it('scrolls up just enough when the row is above the viewport', () => {
    const list = fakeList(50);
    scrollRowIntoView(list, row(30));
    expect(list.scrollTop).toBe(30);
  });

  it('scrolls down just enough when the row is below the viewport', () => {
    const list = fakeList(0);
    scrollRowIntoView(list, row(200));
    expect(list.scrollTop).toBe(120);
  });
});
