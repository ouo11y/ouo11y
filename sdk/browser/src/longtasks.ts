import type { Attrs, LongTaskOptions } from "./types";
import { attempt, guard } from "./guard";
import type { EventEmitter } from "./telemetry/events";

export const LONG_TASK_EVENT = "ouo.long_task";
export const LONG_ANIMATION_FRAME_EVENT = "ouo.long_animation_frame";

interface LoafScript {
  duration: number;
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: LoafScript[];
}

interface LongTaskEntry extends PerformanceEntry {
  attribution?: Array<{ containerType?: string; containerName?: string; containerSrc?: string }>;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** Pure: `ouo.long_animation_frame` attributes, with the longest script as the culprit. */
export function longAnimationFrameAttributes(entry: LoafEntry, path: string): Attrs {
  const attrs: Attrs = {
    "ouo.long_task.duration_ms": round(entry.duration),
    "ouo.long_task.blocking_duration_ms": round(entry.blockingDuration ?? 0),
    "url.path": path,
  };
  if (typeof entry.renderStart === "number" && entry.renderStart > 0) {
    attrs["ouo.long_task.render_start_ms"] = round(entry.renderStart - entry.startTime);
  }
  const scripts = entry.scripts ?? [];
  attrs["ouo.long_task.script_count"] = scripts.length;
  const top = scripts.reduce<LoafScript | undefined>((a, b) => (!a || b.duration > a.duration ? b : a), undefined);
  if (top) {
    attrs["ouo.long_task.script.duration_ms"] = round(top.duration);
    if (top.invoker) attrs["ouo.long_task.script.invoker"] = top.invoker;
    if (top.invokerType) attrs["ouo.long_task.script.invoker_type"] = top.invokerType;
    if (top.sourceURL) attrs["code.file.path"] = top.sourceURL;
    if (top.sourceFunctionName) attrs["code.function.name"] = top.sourceFunctionName;
    if (typeof top.sourceCharPosition === "number" && top.sourceCharPosition >= 0) {
      attrs["ouo.long_task.script.char_position"] = top.sourceCharPosition;
    }
  }
  return attrs;
}

/** Pure: `ouo.long_task` attributes (Long Tasks API, where Long Animation Frames are missing). */
export function longTaskAttributes(entry: LongTaskEntry, path: string): Attrs {
  const attrs: Attrs = { "ouo.long_task.duration_ms": round(entry.duration), "url.path": path };
  const a = entry.attribution?.[0];
  if (a?.containerType) attrs["ouo.long_task.container_type"] = a.containerType;
  if (a?.containerSrc) attrs["ouo.long_task.container_src"] = a.containerSrc;
  return attrs;
}

/**
 * Observes Long Animation Frames (Chromium 123+), else Long Tasks (older Chromium). Firefox and
 * Safari support neither, so nothing is reported there. Returns an uninstall function.
 */
export function installLongTasks(events: EventEmitter, opts: LongTaskOptions = {}): () => void {
  if (typeof PerformanceObserver !== "function" || typeof performance === "undefined") return () => undefined;
  const supported = (globalThis.PerformanceObserver as { supportedEntryTypes?: readonly string[] } | undefined)?.supportedEntryTypes ?? [];
  const type = supported.includes("long-animation-frame") ? "long-animation-frame" : supported.includes("longtask") ? "longtask" : null;
  if (!type) return () => undefined;
  const threshold = opts.thresholdMs ?? 100;
  let budget = opts.maxPerPage ?? 50;
  const origin = performance.timeOrigin;
  const observer = new PerformanceObserver(
    guard((list: PerformanceObserverEntryList) => {
      for (const entry of list.getEntries()) {
        if (budget <= 0) {
          observer.disconnect();
          return;
        }
        if (entry.duration < threshold) continue;
        budget -= 1;
        const ts = origin + entry.startTime;
        if (type === "long-animation-frame") {
          events.emit(LONG_ANIMATION_FRAME_EVENT, longAnimationFrameAttributes(entry as LoafEntry, location.pathname), "warn", ts);
        } else {
          events.emit(LONG_TASK_EVENT, longTaskAttributes(entry as LongTaskEntry, location.pathname), "warn", ts);
        }
      }
    }),
  );
  attempt(() => observer.observe({ type, buffered: true }));
  return () => observer.disconnect();
}
