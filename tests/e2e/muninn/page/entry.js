// The test page's SDK: the released @ouo11y/browser, bundled by run.mjs with esbuild.
import { flush, getSessionId, init, shutdown } from "@ouo11y/browser";

const c = window.__OUO__;
init({
  endpoint: c.endpoint,
  projectId: c.projectId,
  projectToken: c.projectToken,
  serviceName: "muninn-e2e",
  environment: "local",
  // Short chunks so a few seconds of activity give several of them.
  replay: { mode: "structure/dom", sessionRate: 1, chunkMaxMs: 1000 },
});
window.ouo = { flush, shutdown, getSessionId };
