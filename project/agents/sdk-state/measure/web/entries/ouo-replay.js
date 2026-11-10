import { initRUM } from "@ouo11y/browser";
window.__init = (origin) => { window.__rum = initRUM({ endpoint: origin, replayEndpoint: origin, projectId: "bench", projectToken: "bench", service: { name: "bench", version: "1.0.0", environment: "bench" }, replay: { enabled: true, sampleRate: 1 } }); };
