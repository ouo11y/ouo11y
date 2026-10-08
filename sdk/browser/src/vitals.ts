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

export function installWebVitals(events: EventEmitter): void {
  const report = (metric: Metric): void => {
    events.emit("web_vital", webVitalAttributes(metric, location.pathname));
  };
  onCLS(report);
  onFCP(report);
  onINP(report);
  onLCP(report);
  onTTFB(report);
}
