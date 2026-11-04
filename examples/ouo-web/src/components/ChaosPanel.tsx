import { useEffect, useState } from "react";
import { apiUrl, checkout, getProducts } from "../api";
import { rum } from "../rum";

interface LogLine {
  at: string;
  text: string;
  kind: "ok" | "err" | "info";
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Throws while rendering when armed: the route's OuoErrorBoundary catches it. */
function RenderBomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error("chaos: render error caught by the error boundary");
  return null;
}

export function ChaosPanel({ compact = false }: { compact?: boolean }) {
  const [log, setLog] = useState<LogLine[]>([]);
  const [bomb, setBomb] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(() => rum.replay.isRecording());
  // rrweb is loaded lazily by the SDK, so isRecording() can flip shortly after mount.
  useEffect(() => {
    const t = setInterval(() => setRecording(rum.replay.isRecording()), 1000);
    return () => clearInterval(t);
  }, []);

  const push = (text: string, kind: LogLine["kind"] = "info") =>
    setLog((l) => [{ at: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 30));

  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    const t0 = performance.now();
    try {
      const out = await fn();
      push(`${name}: ${out} (${Math.round(performance.now() - t0)} ms)`, "ok");
    } catch (err) {
      push(`${name}: ${describe(err)} (${Math.round(performance.now() - t0)} ms)`, "err");
    } finally {
      setBusy(null);
    }
  };

  const actions: { id: string; label: string; hint: string; onClick: () => void }[] = [
    {
      id: "slow",
      label: "Slow request",
      hint: "GET /api/products?delay=2000",
      onClick: () => void run("slow", async () => `${(await getProducts({ delay: 2000 })).length} products`),
    },
    {
      id: "fail500",
      label: "500 response",
      hint: "POST /api/checkout?fail=500",
      onClick: () =>
        void run("500", async () => {
          await checkout({ paymentMethod: "card" }, { fail: "500" });
          return "unexpected success";
        }),
    },
    {
      id: "timeout",
      label: "Timeout (abort after 5 s)",
      hint: "GET /api/products?fail=timeout",
      onClick: () =>
        void run("timeout", async () => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new DOMException("client timeout after 5000 ms", "TimeoutError")), 5000);
          try {
            await getProducts({ fail: "timeout" }, ac.signal);
            return "unexpected success";
          } finally {
            clearTimeout(timer);
          }
        }),
    },
    {
      id: "throw",
      label: "Uncaught error",
      hint: "throw inside the click handler (window.onerror, fatal)",
      onClick: () => {
        push("throw: throwing ChaosUncaughtError from the click handler", "err");
        const err = new Error("chaos: uncaught error from click handler");
        err.name = "ChaosUncaughtError";
        throw err;
      },
    },
    {
      id: "reject",
      label: "Unhandled rejection",
      hint: "Promise.reject with no catch (unhandledrejection, fatal)",
      onClick: () => {
        push("reject: rejecting a promise nobody handles", "err");
        void Promise.reject(new Error("chaos: unhandled promise rejection"));
      },
    },
    {
      id: "handled",
      label: "Handled error",
      hint: 'rum.captureError(new Error("handled"))',
      onClick: () => {
        rum.captureError(new Error("handled"), { source: "chaos-panel", severity: "warning" });
        push("captureError: sent Error(\"handled\")", "ok");
      },
    },
    {
      id: "console",
      label: "console.error",
      hint: 'console.error("console failure")',
      onClick: () => {
        console.error("console failure");
        push("console.error: logged \"console failure\"", "ok");
      },
    },
    {
      id: "render-error",
      label: "Render error",
      hint: "a component throws while rendering (OuoErrorBoundary, react.error_boundary)",
      onClick: () => setBomb(true),
    },
    {
      id: "long-task",
      label: "Long task (300 ms)",
      hint: "busy loop in the click handler (ouo.long_animation_frame in Chromium)",
      onClick: () => {
        const end = performance.now() + 300;
        while (performance.now() < end) {
          // block the main thread
        }
        push("long task: blocked the main thread for 300 ms", "ok");
      },
    },
    {
      id: "dead",
      label: "Dead button",
      hint: "does nothing at all (ouo.dead_click); click it fast for ouo.rage_click",
      onClick: () => undefined,
    },
    {
      id: "event",
      label: "Custom event",
      hint: 'rum.addEvent("add_to_cart", { product_id, qty })',
      onClick: () => {
        rum.addEvent("add_to_cart", { product_id: "p-1001", qty: 1, source: "chaos-panel" });
        push("addEvent: add_to_cart {product_id: p-1001, qty: 1}", "ok");
      },
    },
    {
      id: "replay",
      label: recording ? "Pause replay" : "Resume replay",
      hint: `rum.replay.isRecording() = ${recording}`,
      onClick: () => {
        if (rum.replay.isRecording()) rum.replay.pause();
        else rum.replay.resume();
        const now = rum.replay.isRecording();
        setRecording(now);
        push(`replay: ${now ? "resumed" : "paused"}, isRecording() = ${now}`, "ok");
      },
    },
    {
      id: "flush",
      label: "Flush",
      hint: "rum.flush()",
      onClick: () => void run("flush", async () => (await rum.flush(), "flushed")),
    },
  ];

  return (
    <div className={compact ? "chaos chaos-compact" : "chaos"} data-testid="chaos-panel">
      <div className="chaos-buttons ouo-unmask">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="btn chaos-btn"
            data-chaos={a.id}
            onClick={a.onClick}
            disabled={busy !== null && busy !== a.id}
            title={a.hint}
          >
            <span>{a.label}</span>
            {!compact && <small>{a.hint}</small>}
          </button>
        ))}
      </div>
      <RenderBomb armed={bomb} />
      <p className="muted small">
        backend <code>{apiUrl("/api/products")}</code> · session <code>{rum.session.id()}</code>
      </p>
      <ol className="chaos-log" aria-live="polite" data-testid="chaos-log">
        {log.length === 0 && <li className="muted">No actions yet.</li>}
        {log.map((l, i) => (
          <li key={`${l.at}-${i}`} className={`log-${l.kind}`}>
            <time>{l.at}</time> {l.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
