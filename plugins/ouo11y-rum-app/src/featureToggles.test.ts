import { enabledToggles, parseFeatureToggles } from './featureToggles';

describe('parseFeatureToggles (B1)', () => {
  it('reads the comma separated string OUO_FEATURE_TOGGLES_ENABLE expands to', () => {
    expect(parseFeatureToggles('sessionTimelinePanel')).toEqual({ sessionTimelinePanel: true });
    expect(parseFeatureToggles(' sessionTimelinePanel , unknownThing ')).toEqual({ sessionTimelinePanel: true });
    expect(parseFeatureToggles('sessionTimelinePanel unknownThing')).toEqual({ sessionTimelinePanel: true });
  });

  it('is all off for an empty or missing value', () => {
    expect(parseFeatureToggles('')).toEqual({});
    expect(parseFeatureToggles(undefined)).toEqual({});
    expect(parseFeatureToggles(null)).toEqual({});
    expect(enabledToggles(parseFeatureToggles(''))).toEqual([]);
  });

  it('also takes a list or an object of booleans, and ignores unknown names', () => {
    expect(parseFeatureToggles(['sessionTimelinePanel', 'nope'])).toEqual({ sessionTimelinePanel: true });
    expect(parseFeatureToggles({ sessionTimelinePanel: true, nope: true })).toEqual({ sessionTimelinePanel: true });
    expect(parseFeatureToggles({ sessionTimelinePanel: 'true' })).toEqual({ sessionTimelinePanel: true });
    expect(parseFeatureToggles({ sessionTimelinePanel: false })).toEqual({ sessionTimelinePanel: false });
    expect(enabledToggles({ sessionTimelinePanel: false })).toEqual([]);
  });
});
