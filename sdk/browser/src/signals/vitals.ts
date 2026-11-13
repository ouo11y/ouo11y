/**
 * Web vitals (SIG-01, SIG-02, SIG-32): one `browser.web_vital` event per vital per hard page
 * load, when its value is final. FCP and TTFB are final when known; LCP, CLS and INP at the first
 * time the page is hidden or closed. `delta` equals `value`. Every vital carries the view id of
 * the hard page load it measures, even after a soft navigation.
 */
import { onCLS, onFCP, onINP, onLCP, onTTFB, type INPMetricWithAttribution, type Metric } from "web-vitals/attribution";
import type { Attrs } from "../core/limits";
import { cssSelector } from "../core/selector";
import { guard, listen } from "../guard";

export interface VitalsDeps {
  emit(attrs: Attrs, o: { viewId: string | undefined; body?: unknown }): void;
  /** The view id of the hard page load (or of the bfcache restore) being measured. */
  hardViewId(): string | undefined;
  attributionBody: boolean;
}

export function vitalAttributes(m: Pick<Metric, "name" | "value" | "id" | "rating" | "navigationType">): Attrs {
  return {
    "browser.web_vital.name": m.name.toLowerCase(),
    "browser.web_vital.value": m.value,
    "browser.web_vital.delta": m.value,
    "browser.web_vital.id": m.id,
    "browser.web_vital.rating": m.rating,
    "browser.web_vital.navigation_type": m.navigationType,
  };
}

function inpAttribution(m: INPMetricWithAttribution): Attrs {
  const a = m.attribution;
  const out: Attrs = {};
  if (!a) return out;
  if (a.interactionTarget) out["browser.web_vital.attribution.interaction_target"] = a.interactionTarget;
  if (a.interactionType) out["browser.web_vital.attribution.interaction_type"] = a.interactionType;
  for (const [key, v] of [["input_delay", a.inputDelay], ["processing_duration", a.processingDuration], ["presentation_delay", a.presentationDelay]] as const) {
    if (typeof v === "number" && Number.isFinite(v)) out[`browser.web_vital.attribution.${key}`] = Math.round(v * 10) / 10;
  }
  return out;
}

/** The scalar parts of an attribution object: what can go in an event body without DOM references. */
function plain(attribution: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries((attribution ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

export function installWebVitals(d: VitalsDeps): () => void {
  let active = true;
  const sent = new Set<string>();
  const report = (m: Metric, extra: Attrs = {}, body?: unknown): void => {
    // Once per vital per page load: the id changes on a bfcache restore, which is a new load.
    if (!active || sent.has(m.id)) return;
    if (sent.size > 64) sent.clear();
    sent.add(m.id);
    d.emit({ ...vitalAttributes(m), ...extra }, { viewId: d.hardViewId(), ...(body !== undefined ? { body } : {}) });
  };
  onFCP(guard((m) => report(m)));
  onTTFB(guard((m) => report(m)));
  onLCP(guard((m) => report(m)));
  onCLS(guard((m) => report(m)));

  // web-vitals forces its final INP report from a `visibilitychange` listener that runs before
  // its queue of interaction entries is drained, so an interaction in the last moments before the
  // page is hidden would be lost. The latest value is followed instead and reported at hide.
  let latest: INPMetricWithAttribution | null = null;
  onINP(
    guard((m) => {
      latest = m;
    }),
    // The target is described by the SDK's own selector rules (PRV-9), not web-vitals' default.
    { reportAllChanges: true, generateTarget: (el) => (el && el.nodeType === 1 ? cssSelector(el as Element) : undefined) },
  );
  const onHidden = (event: Event): void => {
    if ((event.type === "visibilitychange" && document.visibilityState !== "hidden") || !latest) return;
    report(latest, inpAttribution(latest), d.attributionBody ? plain(latest.attribution) : undefined);
  };
  const offVisibility = listen(document, "visibilitychange", onHidden);
  const offPageHide = listen(globalThis, "pagehide", onHidden);
  return () => {
    active = false;
    offVisibility();
    offPageHide();
  };
}
