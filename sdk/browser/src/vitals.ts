import { guard } from "./guard";
import { clickTarget, elementId } from "./interactions/element";
import type { RouteState } from "./telemetry/correlation";
import type { EventEmitter } from "./telemetry/events";
import type { VitalAttrs } from "./vitals/attribution";

const INP_ID = "ouo.web_vital.id";
const INP_VALUE = "ouo.web_vital.value";

/**
 * Reports CLS, FCP, INP, LCP and TTFB as `web_vital` events, INP with its attribution (target,
 * phases, the Long Animation Frame script). web-vitals and the mapping are in a lazily loaded
 * chunk (`src/vitals/attribution.ts`, imported at once); its observers read buffered entries, so
 * the page load's metrics are complete. Returns an uninstall function.
 *
 * INP is followed with `reportAllChanges` and emitted by this module when the page is hidden.
 * web-vitals queues interaction entries for an idle callback and forces its final INP report from
 * a `visibilitychange` listener that runs before that queue is drained, so an interaction in the
 * last second before the tab is hidden or closed was lost (no INP at all when it was the only
 * one). Our listener is on `document`, after web-vitals' `window` capture listeners, so the latest
 * value is known by then. Safari fires `pagehide` without `visibilitychange` when a tab closes,
 * so INP is also emitted on `pagehide`; Chromium fires `pagehide` first, and the
 * `visibilitychange` that follows emits again only if the value grew (same `ouo.web_vital.id`,
 * the later event wins). The listeners are added here, synchronously, before the SDK's
 * flush-on-hide listeners, so the event is flushed.
 */
export function installWebVitals(events: EventEmitter, route?: RouteState): () => void {
  let active = true;
  let latestInp: VitalAttrs | null = null;
  const sent = new Map<string | number, number>();
  const emit = (attrs: VitalAttrs): void => {
    if (active) events.emit("web_vital", attrs);
  };
  import("./vitals/attribution")
    .then(
      guard((m: typeof import("./vitals/attribution")) =>
        m.startWebVitals({
          report: emit,
          // Emitted later, at page hide: the route is the one of the interaction, not of the hide.
          inp: (attrs) => {
            if (active) latestInp = route?.name ? { ...attrs, "app.screen.name": route.name } : attrs;
          },
          // The element a click event names (`app.widget.id`): tag, id, classes, data-testid, no text.
          target: (node) => {
            const el = clickTarget(node);
            return el ? elementId(el) : "";
          },
        }),
      ),
    )
    .catch(() => undefined);
  const onHidden = guard((event: Event): void => {
    if ((event.type === "visibilitychange" && document.visibilityState !== "hidden") || !latestInp) return;
    const id = latestInp[INP_ID]!;
    const value = latestInp[INP_VALUE] as number;
    const previous = sent.get(id);
    if (previous === value) return;
    sent.set(id, value);
    emit({ ...latestInp, "ouo.web_vital.delta": value - (previous ?? 0) });
  });
  document.addEventListener("visibilitychange", onHidden);
  globalThis.addEventListener("pagehide", onHidden);
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", onHidden);
    globalThis.removeEventListener("pagehide", onHidden);
  };
}
