import * as Sentry from "@sentry/browser";
window.__init = (origin) => { const u = new URL(origin); Sentry.init({ dsn: `http://pub@${u.host}/1`, release: "bench@1.0.0", environment: "bench" }); };
