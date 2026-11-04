// The lazily loaded vitals chunk (`dist/attribution-*.js`): web-vitals' attribution build and the
// mapping to `web_vital` attributes. Like `src/replay/rrweb.ts` it must not import a core module
// (esbuild would emit a shared chunk outside the size budget); the core passes what it needs.
import { onCLS, onFCP, onINP, onLCP, onTTFB, type INPAttribution, type INPMetricWithAttribution, type Metric } from "web-vitals/attribution";

export type VitalAttrs = Record<string, string | number>;

const round = (n: number): number => Math.round(n * 10) / 10;

/** Pure mapping from a web-vitals metric to the `web_vital` event attributes. */
export function webVitalAttributes(metric: Pick<Metric, "name" | "value" | "rating" | "id" | "delta" | "navigationType">, path: string): VitalAttrs {
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
 * Pure: the INP attribution attributes. The target is kept only when `ownTarget` says the SDK
 * generated it (a selector without text, like `app.widget.id`); web-vitals falls back to the
 * browser's own `targetSelector` when the element left the DOM, which is left out. The script is
 * the longest Long Animation Frame script that overlapped the interaction, with the same
 * `code.*` attributes as the `ouo.long_animation_frame` event.
 */
export function inpAttributes(a: Partial<INPAttribution>, ownTarget: (t: string) => boolean): VitalAttrs {
  const attrs: VitalAttrs = {};
  if (a.interactionTarget && ownTarget(a.interactionTarget)) attrs["ouo.web_vital.inp.target"] = a.interactionTarget;
  if (a.interactionType) attrs["ouo.web_vital.inp.interaction_type"] = a.interactionType;
  if (typeof a.inputDelay === "number") attrs["ouo.web_vital.inp.input_delay_ms"] = round(a.inputDelay);
  if (typeof a.processingDuration === "number") attrs["ouo.web_vital.inp.processing_duration_ms"] = round(a.processingDuration);
  if (typeof a.presentationDelay === "number") attrs["ouo.web_vital.inp.presentation_delay_ms"] = round(a.presentationDelay);
  if (a.loadState) attrs["ouo.web_vital.inp.load_state"] = a.loadState;
  const script = a.longestScript;
  if (script) {
    const e = script.entry;
    attrs["ouo.web_vital.inp.script.duration_ms"] = round(script.intersectingDuration);
    attrs["ouo.web_vital.inp.script.subpart"] = script.subpart;
    if (e.invoker) attrs["ouo.web_vital.inp.script.invoker"] = e.invoker;
    if (e.invokerType) attrs["ouo.web_vital.inp.script.invoker_type"] = e.invokerType;
    if (e.sourceURL) attrs["code.file.path"] = e.sourceURL;
    if (e.sourceFunctionName) attrs["code.function.name"] = e.sourceFunctionName;
    if (typeof e.sourceCharPosition === "number" && e.sourceCharPosition >= 0) attrs["ouo.web_vital.inp.script.char_position"] = e.sourceCharPosition;
  }
  return attrs;
}

export interface VitalsHooks {
  /** CLS, FCP, LCP and TTFB, as reported. */
  report(attrs: VitalAttrs): void;
  /** Every INP change, with attribution; the core emits the latest when the page is hidden. */
  inp(attrs: VitalAttrs): void;
  /** The INP target of an event target: a selector without text, or "" for none. */
  target(node: Node): string;
}

/** Subscribes to the five metrics. web-vitals has no unsubscribe: the core gates the hooks. */
export function startWebVitals(hooks: VitalsHooks): void {
  const safe =
    <T>(fn: (m: T) => void) =>
    (m: T): void => {
      try {
        fn(m);
      } catch {
        // A mapping bug must not reach the page.
      }
    };
  const report = safe((m: Metric) => hooks.report(webVitalAttributes(m, location.pathname)));
  onCLS(report);
  onFCP(report);
  onLCP(report);
  onTTFB(report);
  let own = new Set<string>();
  onINP(
    safe((m: INPMetricWithAttribution) => hooks.inp({ ...webVitalAttributes(m, location.pathname), ...inpAttributes(m.attribution, (t) => own.has(t)) })),
    {
      reportAllChanges: true,
      generateTarget: (node) => {
        let t = "";
        try {
          if (node) t = hooks.target(node);
        } catch {
          // No target rather than web-vitals' own selector.
        }
        if (own.size >= 1000) own = new Set();
        own.add(t);
        return t;
      },
    },
  );
}
