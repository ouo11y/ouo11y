import { createContext, useContext } from 'react';

/**
 * Plugin feature toggles, Grafana style: off by default, switched on by listing their names in
 * `jsonData.featureToggles`. Provisioning fills it from `OUO_FEATURE_TOGGLES_ENABLE` (a comma
 * separated list, like Grafana's `GF_FEATURE_TOGGLES_ENABLE`); the Helm chart from
 * `grafana.plugin.featureToggles`. The list is documented in the plugin README.
 */
export const FEATURE_TOGGLES = {
  /** The left Timeline panel on the session page, next to the replay and its activity list. */
  sessionTimelinePanel: 'Show the Timeline panel on the session page, next to the replay and its activity list.',
} as const;

export type FeatureToggle = keyof typeof FEATURE_TOGGLES;

export type FeatureToggles = Partial<Record<FeatureToggle, boolean>>;

export const isFeatureToggle = (name: string): name is FeatureToggle =>
  Object.prototype.hasOwnProperty.call(FEATURE_TOGGLES, name);

/**
 * Parses `jsonData.featureToggles`: a comma or space separated string (what `${OUO_FEATURE_TOGGLES_ENABLE}`
 * expands to), an array of names, or an object of booleans. Unknown names are ignored.
 */
export function parseFeatureToggles(raw: unknown): FeatureToggles {
  const out: FeatureToggles = {};
  const enable = (name: unknown, on = true) => {
    if (typeof name === 'string' && isFeatureToggle(name.trim())) {
      out[name.trim() as FeatureToggle] = on;
    }
  };
  if (typeof raw === 'string') {
    raw.split(/[\s,]+/).forEach((n) => enable(n));
  } else if (Array.isArray(raw)) {
    raw.forEach((n) => enable(n));
  } else if (raw && typeof raw === 'object') {
    Object.entries(raw as Record<string, unknown>).forEach(([n, v]) => enable(n, v === true || v === 'true'));
  }
  return out;
}

/** Names of the toggles that are on, in declaration order. */
export const enabledToggles = (t: FeatureToggles): FeatureToggle[] =>
  (Object.keys(FEATURE_TOGGLES) as FeatureToggle[]).filter((n) => t[n]);

export const FeatureTogglesContext = createContext<FeatureToggles>({});

export function useFeatureToggle(name: FeatureToggle): boolean {
  return Boolean(useContext(FeatureTogglesContext)[name]);
}
