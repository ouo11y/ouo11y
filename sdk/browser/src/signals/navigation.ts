/**
 * Navigation and views (SIG-14 to SIG-18, REC-2, API-5).
 *
 * - `browser.navigation` once per page load, as early as possible, and once per History API
 *   navigation (`same_document=true`). Hash-only changes are off by default.
 * - A new `ouo.view.id` for every one of them, and for a bfcache restore.
 * - After `load`: the `documentLoad` span, made after the fact from `fetchStart` to
 *   `loadEventEnd` with no children and no span events (REC-6), parented to the server's
 *   `<meta name="traceparent">` when the page has one (PRP-5), and `browser.navigation_timing`.
 * - `browser.resource_timing`, one event per resource, when switched on.
 *
 * The patched history methods call the original first and return its result; an exception the
 * original throws reaches the caller unchanged, and nothing the SDK does afterwards can throw
 * (ERR-2).
 */
import { ROOT_CONTEXT, SpanKind, trace, TraceFlags, type Context, type Tracer } from "@opentelemetry/api";
import type { Clock } from "../core/clock";
import { newViewId } from "../core/ids";
import type { Attrs } from "../core/limits";
import { attempt, guard, listen } from "../guard";

/** Two reports of one navigation (automatic and `trackNavigation`) this close together are one. */
const SAME_NAVIGATION_MS = 1000;
const RESOURCE_EVENTS_PER_VIEW = 200;

/** The current view: one visit to one page (hard load, soft navigation or bfcache restore). */
export class ViewState {
  id: string | undefined;
  /** The view of the hard page load (or bfcache restore): web vitals belong to it (SIG-32). */
  hardId: string | undefined;
  /** Route name given by `trackNavigation`. */
  name: string | undefined;

  next(id?: string, hard = false): string {
    this.id = id && /^[\w-]{1,64}$/.test(id) ? id : newViewId();
    if (hard) this.hardId = this.id;
    this.name = undefined;
    return this.id;
  }
}

export interface NavigationDeps {
  clock: Clock;
  view: ViewState;
  tracer: Tracer;
  sanitize(url: string): string;
  emit(name: string, attrs: Attrs, o?: { time?: number }): void;
  /** A navigation is user activity (SES-5) and "something happened" for dead clicks. */
  onNavigation(): void;
  navigation: boolean;
  hashNavigation: boolean;
  documentLoad: boolean;
  navigationTiming: boolean;
  resourceTiming: boolean;
  /** URLs never reported as resources (the SDK's own exports). */
  ignoreResource(url: string): boolean;
}

export interface NavigationHandle {
  /** `trackNavigation(name, { url, id })`: the same as an automatic soft navigation. */
  track(name: string, o?: { url?: string | undefined; id?: string | undefined }): void;
  /** A page restored from the back/forward cache is a new view (LIF-8). */
  restored(): void;
  uninstall(): void;
}

type NavigationType = "push" | "replace" | "reload" | "traverse";

function hardType(): NavigationType {
  const nav = attempt(() => performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined);
  return nav?.type === "reload" ? "reload" : nav?.type === "back_forward" ? "traverse" : "push";
}

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const NAV_MILESTONES = [
  "fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "responseEnd",
  "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd", "redirectStart", "redirectEnd",
  "unloadEventStart", "unloadEventEnd", "workerStart", "duration", "transferSize", "encodedBodySize", "decodedBodySize", "redirectCount",
] as const;
const RESOURCE_FIELDS = [
  "fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "responseEnd",
  "duration", "transferSize", "encodedBodySize", "decodedBodySize", "redirectStart", "redirectEnd", "workerStart",
] as const;

function timings(prefix: string, entry: PerformanceEntry, fields: readonly string[]): Attrs {
  const out: Attrs = {};
  for (const f of fields) {
    const v = (entry as unknown as Record<string, unknown>)[f];
    if (typeof v === "number" && Number.isFinite(v)) out[`${prefix}.${snake(f)}`] = Math.round(v * 10) / 10;
  }
  return out;
}

/** The server's trace context from `<meta name="traceparent">`, for the `documentLoad` span only. */
function serverContext(): Context {
  const meta = attempt(() => document.querySelector('meta[name="traceparent"]')?.getAttribute("content"));
  const m = typeof meta === "string" ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(meta.trim()) : null;
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: m[1]!, spanId: m[2]!, traceFlags: parseInt(m[3]!, 16) & TraceFlags.SAMPLED, isRemote: true });
}

export function installNavigation(d: NavigationDeps): NavigationHandle {
  const offs: Array<() => void> = [];
  let active = true;
  let currentUrl = location.href;
  let last: { url: string; at: number } | null = null;
  let resources = 0;

  const navigate = (type: NavigationType, sameDocument: boolean, o: { name?: string; url?: string; id?: string; hash?: boolean } = {}): void => {
    const url = o.url ?? location.href;
    const now = d.clock.now();
    const clean = d.sanitize(url);
    // The router's `trackNavigation` and the History API hook report the same navigation.
    if (last && last.url === clean && now - last.at < SAME_NAVIGATION_MS && sameDocument) {
      if (o.name) d.view.name = o.name;
      return;
    }
    last = { url: clean, at: now };
    d.view.next(o.id, !sameDocument);
    if (o.name) d.view.name = o.name;
    resources = 0;
    d.onNavigation();
    if (!d.navigation) return;
    const attrs: Attrs = {
      "url.full": clean,
      "browser.navigation.same_document": sameDocument,
      "browser.navigation.hash_change": o.hash === true,
      "browser.navigation.type": type,
    };
    if (o.name) attrs["ouo.view.name"] = o.name;
    d.emit("browser.navigation", attrs);
  };

  const onHistory = (type: NavigationType): void => {
    const next = location.href;
    if (next === currentUrl) return;
    const hashOnly = withoutHash(next) === withoutHash(currentUrl);
    currentUrl = next;
    if (hashOnly && !d.hashNavigation) return;
    navigate(type, true, { hash: hashOnly });
  };

  // ---- hard page load ----
  // The view of the page load was opened by the caller, before the session started.
  navigate(hardType(), false, d.view.id ? { id: d.view.id } : {});

  // ---- soft navigations ----
  const history = globalThis.history;
  const originalPush = history?.pushState;
  const originalReplace = history?.replaceState;
  if (history && typeof originalPush === "function" && typeof originalReplace === "function") {
    const afterPush = guard(() => onHistory("push"));
    const afterReplace = guard(() => onHistory("replace"));
    const patchedPush = function ouoPushState(this: History, ...args: Parameters<History["pushState"]>): void {
      const r = originalPush.apply(this, args);
      if (active) afterPush();
      return r;
    };
    const patchedReplace = function ouoReplaceState(this: History, ...args: Parameters<History["replaceState"]>): void {
      const r = originalReplace.apply(this, args);
      if (active) afterReplace();
      return r;
    };
    // A frozen or non-writable history (some sandboxes) is left alone: no soft navigations then.
    attempt(() => {
      history.pushState = patchedPush;
      history.replaceState = patchedReplace;
    });
    offs.push(() =>
      attempt(() => {
        // Restore only what is still ours: a router that wrapped history after the SDK keeps its
        // wrapper, which calls ours, which is now a pass-through.
        if (history.pushState === patchedPush) history.pushState = originalPush;
        if (history.replaceState === patchedReplace) history.replaceState = originalReplace;
      }),
    );
  }
  offs.push(listen(globalThis, "popstate", () => onHistory("traverse")));
  offs.push(listen(globalThis, "hashchange", () => onHistory("traverse")));

  // ---- after load: documentLoad span and navigation timing ----
  const afterLoad = (): void => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav || !(nav.loadEventEnd > 0)) return;
    const origin = performance.timeOrigin;
    const url = d.sanitize(nav.name || location.href);
    if (d.documentLoad) {
      const span = d.tracer.startSpan("documentLoad", { kind: SpanKind.INTERNAL, startTime: origin + nav.fetchStart, attributes: { "url.full": url } }, serverContext());
      // A span of the first view even when a soft navigation came before `load`.
      if (d.view.hardId) span.setAttribute("ouo.view.id", d.view.hardId);
      span.end(origin + nav.loadEventEnd);
    }
    if (d.navigationTiming) d.emit("browser.navigation_timing", { "url.full": url, ...timings("browser.navigation_timing", nav, NAV_MILESTONES) });
  };
  if (d.documentLoad || d.navigationTiming) {
    // `loadEventEnd` is set only after the load handlers have run: one task later.
    const later = (): void => void d.clock.setTimeout(afterLoad, 0);
    if (document.readyState === "complete") later();
    else {
      const off = listen(globalThis, "load", () => {
        off();
        later();
      });
      offs.push(off);
    }
  }

  // ---- resource timing (off by default) ----
  if (d.resourceTiming && typeof PerformanceObserver === "function") {
    attempt(() => {
      const po = new PerformanceObserver(
        guard((list: PerformanceObserverEntryList) => {
          for (const e of list.getEntries()) {
            if (resources >= RESOURCE_EVENTS_PER_VIEW) return;
            if (d.ignoreResource(e.name)) continue;
            resources++;
            const r = e as PerformanceResourceTiming;
            d.emit(
              "browser.resource_timing",
              { "url.full": d.sanitize(r.name), "browser.resource_timing.initiator_type": r.initiatorType, ...timings("browser.resource_timing", r, RESOURCE_FIELDS) },
              // Timestamp is the resource start.
              { time: performance.timeOrigin + r.startTime },
            );
          }
        }),
      );
      po.observe({ type: "resource", buffered: true });
      offs.push(() => po.disconnect());
    });
  }

  return {
    track(name, o = {}) {
      const url = typeof o.url === "string" && o.url !== "" ? attempt(() => new URL(o.url!, location.href).href, o.url) : location.href;
      navigate("push", true, { name, url, ...(o.id !== undefined ? { id: o.id } : {}) });
    },
    restored() {
      last = null;
      currentUrl = location.href;
      navigate("traverse", false);
    },
    uninstall() {
      active = false;
      for (const off of offs) off();
    },
  };
}
