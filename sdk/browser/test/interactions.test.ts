import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { FallbackContextManager } from "../src/interactions/context";
import { clickTarget, describeElement, isDeadClickCandidate } from "../src/interactions/element";
import { FilteringSpanProcessor, InteractionTracker } from "../src/interactions/tracker";
import { longAnimationFrameAttributes, longTaskAttributes } from "../src/longtasks";

function html(markup: string): Element {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

describe("describeElement", () => {
  afterEach(() => (document.body.innerHTML = ""));

  it("builds a CSS-like id and names a button by its text", () => {
    const el = html('<button id="buy" class="btn primary extra" data-testid="buy-btn">  Buy   now </button>');
    expect(describeElement(el)).toEqual({ id: "button#buy.btn.primary[data-testid=buy-btn]", name: "buy-btn" });
    expect(describeElement(html("<button>  Buy   now </button>"))).toEqual({ id: "button", name: "Buy now" });
  });

  it("prefers aria-label, never reads text of other elements or inside ouo-mask", () => {
    expect(describeElement(html('<div aria-label="Close dialog">x</div>')).name).toBe("Close dialog");
    expect(describeElement(html("<div>secret text</div>")).name).toBe("");
    expect(describeElement(html('<div class="ouo-mask"><button>Pay 4242</button></div>').firstElementChild!).name).toBe("");
    expect(describeElement(html('<input type="text" value="secret" name="email">')).name).toBe("email");
  });

  it("truncates long names", () => {
    expect(describeElement(html(`<button>${"x".repeat(100)}</button>`)).name).toHaveLength(64);
  });

  it("attributes a click inside a button to the button", () => {
    const b = html("<button id=b><span><svg></svg>Buy</span></button>");
    expect(clickTarget(b.querySelector("svg"))).toBe(b);
    expect(clickTarget(null)).toBeNull();
  });
});

describe("isDeadClickCandidate", () => {
  it("buttons and role=button count; fields, labels and leaving links do not", () => {
    expect(isDeadClickCandidate(html("<button>x</button>"), false)).toBe(true);
    expect(isDeadClickCandidate(html('<div role="button">x</div>'), false)).toBe(true);
    expect(isDeadClickCandidate(html("<button disabled>x</button>"), false)).toBe(false);
    expect(isDeadClickCandidate(html('<input type="checkbox">'), false)).toBe(false);
    expect(isDeadClickCandidate(html("<label>x</label>"), false)).toBe(false);
    expect(isDeadClickCandidate(html("<select></select>"), false)).toBe(false);
    expect(isDeadClickCandidate(html('<a href="/x">x</a>'), false)).toBe(false);
    expect(isDeadClickCandidate(html('<a href="/x">x</a>'), true)).toBe(true);
    expect(isDeadClickCandidate(html("<a>x</a>"), false)).toBe(true);
    const form = html("<form><button>Send</button><button type=button>Other</button></form>");
    expect(isDeadClickCandidate(form.children[0]!, false)).toBe(false);
    expect(isDeadClickCandidate(form.children[0]!, true)).toBe(true);
    expect(isDeadClickCandidate(form.children[1]!, false)).toBe(true);
    expect(isDeadClickCandidate(html("<div>x</div>"), false)).toBe(false);
  });
});

describe("InteractionTracker", () => {
  let exporter: InMemorySpanExporter;
  let tracker: InteractionTracker;
  let provider: BasicTracerProvider;
  let cm: FallbackContextManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Ahead of the real time origin: OTel reads an epoch-ms number earlier than
    // performance.timeOrigin as a performance-relative time.
    vi.setSystemTime(Date.now() + 60_000);
    exporter = new InMemorySpanExporter();
    tracker = new InteractionTracker({ tracer: () => provider.getTracer("t"), idleTimeoutMs: 1000, maxDurationMs: 5000, mutationObserver: undefined });
    provider = new BasicTracerProvider({
      spanProcessors: [tracker, new FilteringSpanProcessor(new SimpleSpanProcessor(exporter), (s) => tracker.shouldExport(s))],
    });
    cm = new FallbackContextManager();
    cm.enable();
    context.setGlobalContextManager(cm);
    cm.setFallback(() => tracker.activeContext());
  });

  afterEach(() => {
    context.disable();
    vi.useRealTimers();
  });

  const names = () => exporter.getFinishedSpans().map((s) => s.name);

  it("the open span is the fallback parent, an explicit context still wins", () => {
    const click = tracker.begin("click", "click", {});
    const child = provider.getTracer("t").startSpan("GET");
    expect(child.spanContext().traceId).toBe(click.span.spanContext().traceId);
    expect(click.inflight).toBe(1);
    const explicit = context.with(trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 })), () =>
      provider.getTracer("t").startSpan("explicit"),
    );
    expect(explicit.spanContext().traceId).toBe("a".repeat(32));
    child.end(Date.now());
    explicit.end(Date.now());
  });

  it("waits for open children, then ends one idle period after the last activity, at that activity", () => {
    const click = tracker.begin("click", "click", {});
    const child = provider.getTracer("t").startSpan("GET");
    vi.advanceTimersByTime(3000);
    expect(names()).not.toContain("click");
    const childEnd = Date.now();
    child.end(childEnd);
    vi.advanceTimersByTime(999);
    expect(names()).not.toContain("click");
    vi.advanceTimersByTime(1);
    const span = exporter.getFinishedSpans().find((s) => s.name === "click")!;
    expect(span.attributes["ouo.interaction.end_reason"]).toBe("idle");
    expect(span.endTime[0] * 1000 + span.endTime[1] / 1e6).toBe(childEnd);
    expect(tracker.activeContext()).toBeUndefined();
    expect(click.children).toBe(1);
  });

  it("drops a click with no child but keeps a navigation", () => {
    tracker.begin("click", "click", {});
    vi.advanceTimersByTime(1000);
    tracker.begin("navigation", "soft-navigation", {});
    vi.advanceTimersByTime(1000);
    expect(names()).toEqual(["soft-navigation"]);
  });

  it("a navigation under a click keeps the click open until the navigation ends", () => {
    const click = tracker.begin("click", "click", {});
    const nav = tracker.begin("navigation", "soft-navigation", {}, { parent: click.context });
    expect(tracker.activeContext()).toBe(nav.context);
    tracker.noteMutation();
    expect(nav.mutated).toBe(true);
    expect(click.mutated).toBe(false);
    // The click's last activity is the navigation's end read back from hrtime: allow rounding.
    vi.advanceTimersByTime(1010);
    expect(names()).toEqual(["soft-navigation", "click"]);
    const [n, c] = exporter.getFinishedSpans();
    expect(n!.parentSpanContext?.spanId).toBe(c!.spanContext().spanId);
  });

  it("a new click supersedes the open one; maxDuration caps a busy span", () => {
    const first = tracker.begin("click", "click", { n: 1 });
    const onEnd = vi.fn();
    tracker.begin("click", "click", { n: 2 }, { onEnd });
    expect(first.span.isRecording()).toBe(false);
    const child = provider.getTracer("t").startSpan("GET");
    vi.advanceTimersByTime(5000);
    expect(onEnd).toHaveBeenCalledWith(expect.anything(), "timeout");
    child.end(Date.now());
  });

  it("detached spans are never parents and never exported", () => {
    tracker.begin("click", "click", {}, { detached: true });
    expect(tracker.activeContext()).toBeUndefined();
    tracker.noteMutation();
    vi.advanceTimersByTime(2000);
    expect(names()).toEqual([]);
  });

  it("endAll ends every open span with the reason", () => {
    const onEnd = vi.fn();
    tracker.begin("navigation", "soft-navigation", {}, { onEnd });
    tracker.endAll("hidden");
    expect(onEnd).toHaveBeenCalledWith(expect.anything(), "hidden");
    expect(exporter.getFinishedSpans()[0]!.attributes["ouo.interaction.end_reason"]).toBe("hidden");
  });
});

describe("long task attributes", () => {
  it("names the longest script of a long animation frame", () => {
    const attrs = longAnimationFrameAttributes(
      {
        name: "long-animation-frame",
        entryType: "long-animation-frame",
        startTime: 100,
        duration: 182.34,
        blockingDuration: 132.3,
        renderStart: 270,
        scripts: [
          { duration: 20, invoker: "a" },
          { duration: 150, invoker: "BUTTON#slow.onclick", invokerType: "event-listener", sourceURL: "https://app/x.js", sourceFunctionName: "block", sourceCharPosition: 42 },
        ],
        toJSON: () => ({}),
      },
      "/chaos",
    );
    expect(attrs).toEqual({
      "ouo.long_task.duration_ms": 182.3,
      "ouo.long_task.blocking_duration_ms": 132.3,
      "ouo.long_task.render_start_ms": 170,
      "ouo.long_task.script_count": 2,
      "ouo.long_task.script.duration_ms": 150,
      "ouo.long_task.script.invoker": "BUTTON#slow.onclick",
      "ouo.long_task.script.invoker_type": "event-listener",
      "code.file.path": "https://app/x.js",
      "code.function.name": "block",
      "ouo.long_task.script.char_position": 42,
      "url.path": "/chaos",
    });
  });

  it("maps a long task with its container", () => {
    expect(
      longTaskAttributes(
        { name: "self", entryType: "longtask", startTime: 0, duration: 75, attribution: [{ containerType: "iframe", containerSrc: "https://ads" }], toJSON: () => ({}) },
        "/",
      ),
    ).toEqual({ "ouo.long_task.duration_ms": 75, "ouo.long_task.container_type": "iframe", "ouo.long_task.container_src": "https://ads", "url.path": "/" });
  });
});
