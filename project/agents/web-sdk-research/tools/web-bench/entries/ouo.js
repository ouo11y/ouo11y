// @ouo11y/browser, built from the worktree (sdk/browser, tsup). Defaults except the endpoints.
import { initRUM } from "@ouo11y/browser";

const { intake } = window.__BENCH__;
initRUM({
  endpoint: `${intake}/ouo`,
  replayEndpoint: `${intake}/ouo`,
  projectId: "bench",
  projectToken: "pt_bench_0000000000000000",
  service: { name: "web-bench", version: "1.0.0", environment: "bench" },
  replay: { enabled: __REPLAY__ }, // maskAllInputs: true, sampleRate: 1 are the defaults
});
performance.mark("sdk-init-done");
