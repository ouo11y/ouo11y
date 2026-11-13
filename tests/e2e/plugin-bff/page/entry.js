// The test page's SDK, bundled by run.mjs with esbuild: the released @ouo11y/browser, or the
// source tree named by OUO_BROWSER_SDK_SRC.
import { flush, getSessionId, init, recordEvent, recordException, setUser, shutdown } from "@ouo11y/browser";

const c = window.__OUO__;
init({
  endpoint: c.endpoint,
  projectId: c.projectId,
  projectToken: c.projectToken,
  serviceName: "plugin-bff-e2e",
  environment: "local",
  replay: { mode: "structure/dom", sessionRate: 1, chunkMaxMs: 1000 },
});
setUser(c.user);
window.ouo = { flush, shutdown, getSessionId, recordEvent, recordException };
