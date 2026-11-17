// ouo RUM: sessions, page views, clicks, errors, web vitals, fetch spans and replay,
// sent as OTLP to the collector of guide 00.
import { init, recordEvent, setUser } from "@ouo11y/browser";

init({
  endpoint: import.meta.env.VITE_OUO_ENDPOINT ?? "http://localhost:4318",
  projectId: "demo",                             // a line of stack/10-collector/projects.htpasswd
  projectToken: "pt_dev_demo_0000000000000000",  // public: it can only write into project demo
  serviceName: "tiny-shop-web",
  serviceVersion: "1.0.0",
  environment: "local",
  replay: { sessionRate: 1 },                    // record every session (default 0: none)
  debug: import.meta.env.DEV,                    // the SDK's diagnostics in the console
});

export { recordEvent, setUser };
