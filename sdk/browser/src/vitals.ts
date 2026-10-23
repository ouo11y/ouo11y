import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import type { EventEmitter } from "./telemetry/events";

/** Pure mapping from a web-vitals metric to the `web_vital` event attributes. */
export function webVitalAttributes(metric: Pick<Metric, "name" | "value" | "rating" | "id" | "delta" | "navigationType">, path: string) {
  return {
    "ouo.web_vital.name": metric.name,
    "ouo.web_vital.value": metric.value,
    "ouo.web_vital.rating": metric.rating,
    "ouo.web_vital.id": metric.id,
    "ouo.web_vital.delta": metric.delta,
    "ouo.web_vital.navigation_type": metric.navigationType,
    "url.path": path,
  };
}

/**
 * Reports CLS, FCP, INP, LCP and TTFB as `web_vital` events. Returns an uninstall function.
 *
 * INP is followed with `reportAllChanges` and emitted by this module when the page is hidden.
 * web-vitals queues interaction entries for an idle callback and forces its final INP report from
 * a `visibilitychange` listener that runs before that queue is drained, so an interaction in the
 * last second before the tab is hidden or closed was lost (no INP at all when it was the only
 * one). Our listener is on `document`, after web-vitals' `window` capture listeners, so the latest
 * value is known by then. Safari fires `pagehide` without `visibilitychange` when a tab closes,
 * so INP is also emitted on `pagehide`; Chromium fires `pagehide` first, and the
 * `visibilitychange` that follows emits again only if the value grew (same `ouo.web_vital.id`,
 * the later event wins). Call before the SDK's flush-on-hide listeners so the event is flushed.
 */
export function installWebVitals(events: EventEmitter): () => void {
  const report = (metric: Metric): void => {
    events.emit("web_vital", webVitalAttributes(metric, location.pathname));
  };
  onCLS(report);
  onFCP(report);
  onLCP(report);
  onTTFB(report);

  let latestInp: { metric: Metric; path: string } | null = null;
  const sent = new Map<string, number>();
  onINP(
    (metric) => {
      latestInp = { metric: { ...metric }, path: location.pathname };
    },
    { reportAllChanges: true },
  );
  const onHidden = (event: Event): void => {
    if ((event.type === "visibilitychange" && document.visibilityState !== "hidden") || !latestInp) return;
    const { metric, path } = latestInp;
    const previous = sent.get(metric.id);
    if (previous === metric.value) return;
    sent.set(metric.id, metric.value);
    events.emit("web_vital", webVitalAttributes({ ...metric, delta: metric.value - (previous ?? 0) }, path));
  };
  document.addEventListener("visibilitychange", onHidden);
  globalThis.addEventListener("pagehide", onHidden);
  return () => {
    document.removeEventListener("visibilitychange", onHidden);
    globalThis.removeEventListener("pagehide", onHidden);
  };
}
