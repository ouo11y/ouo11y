// Overhead measurement build only (OUO_PERF=1, scripts/perf/run.sh). Imported first in index.ts.
//
// JS thread frame monitor, the same idea as React Native's perf monitor: a requestAnimationFrame
// loop on the JS thread; an interval longer than one display frame means the JS thread missed
// frames. The interval histogram (1 ms buckets) and the first-frame time go to
// Documents/perf.json every 2 s; the harness reads the last copy after the run and computes
// dropped frames against the measured refresh interval. Wall-clock (Date.now) times so the host
// can compare them with the process start time from the kernel. A no-op in other builds.
import { File, Paths } from "expo-file-system";
import { config } from "./config";

const jsStartMs = Date.now();
let firstFrameMs: number | null = null;
let frames = 0;
let last = 0;
let maxDt = 0;
const hist: Record<number, number> = {};

function tick(now: number): void {
  if (last > 0) {
    const dt = now - last;
    const bucket = Math.min(2000, Math.round(dt));
    hist[bucket] = (hist[bucket] ?? 0) + 1;
    frames++;
    if (dt > maxDt) maxDt = dt;
  }
  last = now;
  requestAnimationFrame(tick);
}

function write(): void {
  try {
    const f = new File(Paths.document, "perf.json");
    if (!f.exists) f.create();
    f.write(
      JSON.stringify({
        mode: { sentry: config.sentry, ouo: config.ouoSdk, ouoReplay: config.ouoReplay },
        jsStartMs,
        firstFrameMs,
        writtenMs: Date.now(),
        frames,
        maxDt,
        hist,
      }),
    );
  } catch {
    // best effort
  }
}

/** Called once from App after the navigation container is ready: the first screen is on screen. */
export function markFirstFrame(): void {
  if (!config.perfModes || firstFrameMs !== null) return;
  requestAnimationFrame(() => {
    firstFrameMs = Date.now();
    write();
  });
}

if (config.perfModes) {
  requestAnimationFrame(tick);
  setInterval(write, 2000);
}
