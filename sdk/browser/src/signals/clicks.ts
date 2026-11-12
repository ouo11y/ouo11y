/**
 * Clicks and frustration (SIG-10, SIG-13). Every click is one `browser.user_action.click` event:
 * where it landed and what kind of element it hit, never the element's text (SIG-39), and it never
 * starts a trace (SIG-38). On top of the clicks, `ouo.user_action.frustration` reports:
 *
 * - `rage`: four or more clicks on one element within a second, reported once when the burst ends;
 * - `dead`: a click on something that looks actionable, after which nothing happened for two
 *   seconds (no DOM change, navigation or request);
 * - `error`: a click followed by an unhandled error within two seconds.
 */
import type { Clock, TimerHandle } from "../core/clock";
import type { Attrs } from "../core/limits";
import { cssSelector, otelDataAttributes } from "../core/selector";
import { attempt, guard, listen } from "../guard";

export const RAGE_CLICKS = 4;
export const RAGE_WINDOW_MS = 1000;
export const FRUSTRATION_WINDOW_MS = 2000;

/** Elements a user clicks on purpose; a click inside one is attributed to it. */
const ACTIONABLE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"]';

export function clickTarget(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  const el = target as Element;
  return el.closest(ACTIONABLE) ?? el;
}

/**
 * Whether a click on `el` that changed nothing is a dead click. Form fields, labels and
 * checkboxes change state without touching the DOM, and a link or submit button whose default
 * was not prevented leaves the page, so none of those count.
 */
export function isDeadClickCandidate(el: Element, defaultPrevented: boolean): boolean {
  const tag = el.localName;
  if (tag === "select" || tag === "textarea" || tag === "label" || tag === "option") return false;
  if ((el as HTMLElement).isContentEditable) return false;
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (!["button", "submit", "reset", "image"].includes(input.type)) return false;
    if (input.type === "submit" && !defaultPrevented && input.form) return false;
    return !input.disabled;
  }
  if (tag === "a") return !((el as HTMLAnchorElement).hasAttribute("href") && !defaultPrevented);
  if (tag === "button") {
    const b = el as HTMLButtonElement;
    if (b.disabled) return false;
    return !(b.type === "submit" && b.form && !defaultPrevented);
  }
  const role = el.getAttribute("role");
  return role === "button" || role === "link" || role === "menuitem" || role === "tab";
}

export function clickAttributes(e: Pick<MouseEvent, "pageX" | "pageY" | "button">, el: Element): Attrs {
  const attrs: Attrs = {
    "browser.page.x": Math.round(e.pageX),
    "browser.page.y": Math.round(e.pageY),
    "browser.tag_name": el.localName,
    "ouo.viewport.width": globalThis.innerWidth ?? 0,
    "ouo.viewport.height": globalThis.innerHeight ?? 0,
    "browser.css_selector": cssSelector(el),
    "browser.mouse_event.button": e.button,
  };
  const data = otelDataAttributes(el);
  if (data) attrs["browser.element.attributes"] = data;
  return attrs;
}

export interface ClickDeps {
  clock: Clock;
  clicks: boolean;
  frustration: boolean;
  emitClick(attrs: Attrs): void;
  emitFrustration(attrs: Attrs, time: number): void;
  /** Subscribe to "something happened" signals: a request started, a navigation, an unhandled error. */
  onNetwork(fn: () => void): () => void;
  onNavigation(fn: () => void): () => void;
  onError(fn: () => void): () => void;
}

interface Burst {
  el: Element;
  attrs: Attrs;
  count: number;
  first: number;
  timer: TimerHandle;
}

interface Watch {
  attrs: Attrs;
  at: number;
  /** The element looks actionable, so silence after the click means something. */
  candidate: boolean;
  /** A DOM change, navigation or request followed the click. */
  changed: boolean;
  timer: TimerHandle;
}

export function installClicks(d: ClickDeps): () => void {
  let burst: Burst | null = null;
  let watch: Watch | null = null;
  let observer: MutationObserver | null = null;

  const endBurst = (): void => {
    const b = burst;
    burst = null;
    if (!b) return;
    d.clock.clearTimeout(b.timer);
    if (b.count >= RAGE_CLICKS) {
      d.emitFrustration({ ...b.attrs, "ouo.user_action.frustration.type": "rage", "ouo.user_action.frustration.click_count": b.count }, b.first);
    }
  };

  const stopWatch = (): void => {
    if (watch) d.clock.clearTimeout(watch.timer);
    watch = null;
    observer?.disconnect();
    observer = null;
  };
  // A DOM change, navigation or request: the click did something.
  const alive = (): void => {
    if (watch) watch.changed = true;
    observer?.disconnect();
    observer = null;
  };
  const errored = (): void => {
    const w = watch;
    if (!w) return;
    stopWatch();
    d.emitFrustration({ ...w.attrs, "ouo.user_action.frustration.type": "error" }, w.at);
  };

  const onClick = (event: Event): void => {
    const e = event as MouseEvent;
    const el = clickTarget(e.target);
    if (!el) return;
    const now = d.clock.now();
    const attrs = clickAttributes(e, el);
    if (d.clicks) d.emitClick(attrs);
    if (!d.frustration) return;

    if (burst && burst.el === el && now - burst.first <= RAGE_WINDOW_MS) burst.count++;
    else {
      endBurst();
      burst = { el, attrs, count: 1, first: now, timer: d.clock.setTimeout(endBurst, RAGE_WINDOW_MS + 50) };
    }

    // One watch at a time: the latest click is the one a silence or an error is about. It starts
    // now, in the capture phase, so what the page's own handlers do in this very task is seen.
    stopWatch();
    const w: Watch = {
      attrs,
      at: now,
      candidate: false,
      changed: false,
      timer: d.clock.setTimeout(() => {
        const cur = watch;
        stopWatch();
        if (cur?.candidate && !cur.changed) d.emitFrustration({ ...cur.attrs, "ouo.user_action.frustration.type": "dead" }, cur.at);
      }, FRUSTRATION_WINDOW_MS),
    };
    watch = w;
    if (typeof MutationObserver === "function") {
      // Observed only for the two seconds after a click, so an idle page costs nothing.
      observer = new MutationObserver(guard(alive));
      attempt(() => observer!.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }));
    }
    // Whether the default was prevented is known once the page's handlers have run.
    queueMicrotask(
      guard(() => {
        if (watch !== w) return;
        w.candidate = isDeadClickCandidate(el, e.defaultPrevented);
        if (!w.candidate) {
          observer?.disconnect();
          observer = null;
        }
      }),
    );
  };

  const offs = [listen(document, "click", onClick, true), d.onNetwork(alive), d.onNavigation(alive), d.onError(errored), listen(globalThis, "pagehide", endBurst)];
  return () => {
    for (const off of offs) off();
    if (burst) d.clock.clearTimeout(burst.timer);
    burst = null;
    stopWatch();
  };
}
