/**
 * Scrolls `list` (an `overflow-y: auto` container with `position: relative`) the minimum amount that
 * makes `item` fully visible, like `scrollIntoView({ block: 'nearest' })` but without touching any
 * other scroll container, so the page and the pinned replay stay where they are.
 */
export function scrollRowIntoView(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  const viewTop = list.scrollTop;
  const viewBottom = viewTop + list.clientHeight;
  if (top < viewTop) {
    list.scrollTop = top;
  } else if (bottom > viewBottom) {
    list.scrollTop = bottom - list.clientHeight;
  }
}
