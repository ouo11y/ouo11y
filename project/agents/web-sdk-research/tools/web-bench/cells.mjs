// A cell is (SDK entry, replay on/off). Tier 1: replay on at defaults. Tier 2: replay off.
export const CELLS = {
  none: { entry: "none", replay: false, tier: 0 },
  ouo: { entry: "ouo", replay: true, tier: 1 },
  sentry: { entry: "sentry", replay: true, tier: 1 },
  datadog: { entry: "datadog", replay: true, tier: 1 },
  posthog: { entry: "posthog", replay: true, tier: 1 },
  splunk: { entry: "splunk", replay: true, tier: 1 },
  faro: { entry: "faro", replay: false, tier: 2 }, // no replay in Faro
  "ouo-norep": { entry: "ouo", replay: false, tier: 2 },
  "sentry-norep": { entry: "sentry", replay: false, tier: 2 },
  "datadog-norep": { entry: "datadog", replay: false, tier: 2 },
  "posthog-norep": { entry: "posthog", replay: false, tier: 2 },
  "splunk-norep": { entry: "splunk-norep", replay: false, tier: 2 },
};
