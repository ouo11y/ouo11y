import type { Attrs, RageClickOptions } from "../types";
import type { EventEmitter } from "../telemetry/events";
import { guard } from "../guard";
import { systemClock, type Clock } from "../session/clock";
import { clickTarget, describeElement, isDeadClickCandidate } from "./element";
import type { InteractionTracker } from "./tracker";

export const RAGE_CLICK_EVENT = "ouo.rage_click";
export const DEAD_CLICK_EVENT = "ouo.dead_click";

export interface ClickTrackingOptions {
  tracker: InteractionTracker;
  events: EventEmitter;
  /** Open a `click` span per click (interaction tracing). */
  spans: boolean;
  rageClicks: RageClickOptions | false;
  deadClicks: boolean;
  /** With `replay.maskAllText`: the selector outside which no text goes into `app.widget.name`. */
  unmask?: string | undefined;
  /** `replay.maskTextSelector`: no text from inside it either. */
  mask?: string | undefined;
  clock?: Clock;
}

interface Burst {
  widgetId: string;
  attrs: Attrs;
  x: number;
  y: number;
  first: number;
  last: number;
  count: number;
  timer: unknown;
}

/**
 * Click instrumentation: a `click` span per click (the parent of the requests and the soft
 * navigation it causes), `ouo.rage_click` for bursts of clicks on one spot, `ouo.dead_click`
 * for a click on a button or link after which nothing happened (no request, no DOM mutation,
 * no navigation) before the interaction went idle.
 */
export function installClickTracking(opts: ClickTrackingOptions): () => void {
  const { tracker, events } = opts;
  const clock = opts.clock ?? systemClock;
  const rage = opts.rageClicks === false ? null : opts.rageClicks;
  const threshold = rage?.threshold ?? 3;
  const windowMs = rage?.windowMs ?? 1000;
  const radius = rage?.radiusPx ?? 30;
  let burst: Burst | null = null;

  const endBurst = (): void => {
    const b = burst;
    burst = null;
    if (!b) return;
    if (b.timer !== null) clock.clearTimeout(b.timer);
    if (b.count < threshold) return;
    events.emit(
      RAGE_CLICK_EVENT,
      { ...b.attrs, "ouo.click.count": b.count, "ouo.click.duration_ms": b.last - b.first },
      "warn",
      b.first,
    );
  };

  const onClick = guard((event: MouseEvent): void => {
    const el = clickTarget(event.target);
    if (!el) return;
    const now = clock.now();
    const { id, name } = describeElement(el, opts.unmask, opts.mask);
    const attrs: Attrs = {
      "app.widget.id": id,
      "app.screen.coordinate.x": Math.round(event.clientX),
      "app.screen.coordinate.y": Math.round(event.clientY),
      "url.path": location.pathname,
    };
    if (name) attrs["app.widget.name"] = name;

    if (rage) {
      const near = burst && (burst.widgetId === id || Math.hypot(burst.x - event.clientX, burst.y - event.clientY) <= radius);
      if (burst && near && now - burst.first <= windowMs) {
        burst.count += 1;
        burst.last = now;
        clock.clearTimeout(burst.timer);
      } else {
        endBurst();
        burst = { widgetId: id, attrs, x: event.clientX, y: event.clientY, first: now, last: now, count: 1, timer: null };
      }
      burst.timer = clock.setTimeout(endBurst, Math.max(0, burst.first + windowMs - now));
    }

    if (!opts.spans && !opts.deadClicks) return;
    // Decided after the app's handlers ran: only then is defaultPrevented final.
    let candidate = false;
    if (opts.deadClicks) clock.setTimeout(() => (candidate = isDeadClickCandidate(el, event.defaultPrevented)), 0);
    tracker.begin("click", "click", { ...attrs, "ouo.interaction.type": "click" }, {
      startTime: now,
      detached: !opts.spans,
      onEnd: (s, reason) => {
        if (!opts.deadClicks || !candidate || reason !== "idle") return;
        if (s.children > 0 || s.mutated) return;
        events.emit(DEAD_CLICK_EVENT, attrs, "warn", now);
      },
    });
  });

  globalThis.addEventListener("click", onClick, { capture: true, passive: true });
  return () => {
    globalThis.removeEventListener("click", onClick, { capture: true });
    endBurst();
  };
}
