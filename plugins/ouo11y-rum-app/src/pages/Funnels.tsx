import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2, type SelectableValue } from '@grafana/data';
import { locationService, PluginPage } from '@grafana/runtime';
import {
  Alert,
  Button,
  Combobox,
  type ComboboxOption,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingPlaceholder,
  Select,
  Stack,
  useStyles2,
} from '@grafana/ui';
import { rumApi } from '../api/client';
import type { FunnelStep, StepSuggestion } from '../api/types';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { DroppedSessions } from '../components/DroppedSessions';
import { FunnelChart } from '../components/FunnelChart';
import { ScopePicker } from '../components/ScopePicker';
import { TimeRangeBar, useRawRange } from '../components/TimeRangeBar';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useRumQuery } from '../hooks/useRumQuery';
import { isOtherScope, scopeKeyTag, useScope } from '../hooks/useScope';
import { setSearchParams, useSearchParams } from '../hooks/useSearchParams';
import { filtersFromSearch, stepsFromSearch, stepsParam, stepsProblem, withSteps } from '../utils/funnel';

const KIND_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Page', value: 'page', description: 'url.path of a page load or route change' },
  { label: 'Event', value: 'event', description: 'custom event name (rum.addEvent)' },
];
const MATCH_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'is', value: 'exact' },
  { label: 'starts with', value: 'prefix' },
];
const WITHIN_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'No limit', value: '' },
  { label: '5 minutes', value: '5m' },
  { label: '30 minutes', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '1 day', value: '1d' },
];
const PLATFORM_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Any platform', value: '' },
  { label: 'web', value: 'web' },
  { label: 'mobile', value: 'mobile' },
];
// project and service (app) come from the shared ScopePicker (same URL keys).
const TEXT_FILTERS = ['environment', 'release'] as const;
type TextFilter = (typeof TEXT_FILTERS)[number];

export const DEFAULT_FUNNEL: FunnelStep[] = [
  { kind: 'page', match: 'exact', value: '/' },
  { kind: 'page', match: 'exact', value: '' },
];

export function funnelHref(steps: FunnelStep[], extra: Record<string, string> = {}): string {
  const q = withSteps(new URLSearchParams(extra), steps);
  return `${PLUGIN_BASE_URL}/${ROUTES.Funnels}?${q.toString()}`;
}

function suggestionOptions(list: StepSuggestion[] | undefined, current: string): Array<ComboboxOption<string>> {
  const out = (list ?? []).map((s) => ({ value: s.value, label: s.value, description: `${s.count} in range` }));
  if (current && !out.some((o) => o.value === current)) {
    out.unshift({ value: current, label: current, description: 'not seen in range' });
  }
  return out;
}

export default function Funnels() {
  const styles = useStyles2(getStyles);
  const search = useSearchParams();
  const range = useRawRange();
  const urlSteps = useMemo(() => stepsFromSearch(search), [search]);
  const steps = urlSteps.length > 0 ? urlSteps : DEFAULT_FUNNEL;
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const within = search.get('within') ?? '';
  const dropped = Number(search.get('dropped') ?? 0) || undefined;
  const problem = stepsProblem(steps);

  const setSteps = (next: FunnelStep[]) => {
    const q = withSteps(locationService.getSearch(), next);
    locationService.replace({ pathname: locationService.getLocation().pathname, search: q.toString() });
  };
  const update = (i: number, patch: Partial<FunnelStep>) =>
    setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };

  // Never show another scope's numbers under the new scope while its request is in flight.
  const scope = useScope();
  const suggestKey = JSON.stringify({ ...range, ...filters, release: undefined }) + scopeKeyTag(scope);
  const suggestQuery = useRumQuery(
    () => rumApi.funnelSteps({ from: range.from, to: range.to, ...filters, release: undefined }),
    suggestKey
  );
  const suggestions = isOtherScope(suggestQuery.dataKey, scope) ? { ...suggestQuery, data: undefined } : suggestQuery;

  const queryKey = JSON.stringify({ steps, range, filters, within }) + scopeKeyTag(scope);
  const funnelQuery = useRumQuery(
    () => rumApi.funnel({ steps, from: range.from, to: range.to, within: within || undefined, filters }),
    queryKey,
    !problem
  );
  const funnel = isOtherScope(funnelQuery.dataKey, scope) ? { ...funnelQuery, data: undefined } : funnelQuery;

  // Free-text filters are committed on blur / Enter (Sessions page pattern).
  const urlText = TEXT_FILTERS.map((k) => filters[k] ?? '').join('|');
  const [text, setText] = useState<Record<TextFilter, string>>(() => textFrom(filters));
  const [syncedFrom, setSyncedFrom] = useState(urlText);
  if (syncedFrom !== urlText) {
    setSyncedFrom(urlText);
    setText(textFrom(filters));
  }
  const commitText = () => setSearchParams({ ...text, dropped: null });

  return (
    <PluginPage
      actions={
        <Stack gap={1} alignItems="center" wrap="wrap">
          <ScopePicker />
          <TimeRangeBar />
        </Stack>
      }
      subTitle="How many sessions go through the steps in order. A step is a page path or a custom event; the URL holds the funnel, so copy it to share."
    >
      <div className={styles.section}>
        <Stack direction="column" gap={1}>
          {steps.map((step, i) => (
            <Stack key={i} gap={1} alignItems="center">
              <span className={styles.stepNo}>{i + 1}</span>
              <Select
                aria-label={`Step ${i + 1} kind`}
                width={12}
                options={KIND_OPTIONS}
                value={step.kind}
                onChange={(v) =>
                  update(
                    i,
                    v.value === 'page'
                      ? { kind: 'page', match: 'exact', value: '' }
                      : { kind: 'event', match: undefined, value: '' }
                  )
                }
              />
              {step.kind === 'page' && (
                <Select
                  aria-label={`Step ${i + 1} match`}
                  width={16}
                  options={MATCH_OPTIONS}
                  value={step.match ?? 'exact'}
                  onChange={(v) => update(i, { match: v.value === 'prefix' ? 'prefix' : 'exact' })}
                />
              )}
              <div className={styles.value}>
                <Combobox
                  aria-label={`Step ${i + 1} value`}
                  placeholder={step.kind === 'page' ? '/path' : 'event name'}
                  createCustomValue
                  customValueDescription="Use this value"
                  options={suggestionOptions(
                    step.kind === 'page' ? suggestions.data?.pages : suggestions.data?.events,
                    step.value
                  )}
                  value={step.value || null}
                  onChange={(o) => update(i, { value: o?.value ?? '' })}
                  isClearable
                  loading={suggestions.loading}
                />
              </div>
              <IconButton name="arrow-up" tooltip="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton
                name="arrow-down"
                tooltip="Move down"
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
              />
              <IconButton
                name="trash-alt"
                tooltip="Remove step"
                disabled={steps.length <= 2}
                onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              />
            </Stack>
          ))}
          <Stack gap={1}>
            <Button
              variant="secondary"
              icon="plus"
              disabled={steps.length >= 10}
              onClick={() => setSteps([...steps, { kind: 'event', value: '' }])}
            >
              Add step
            </Button>
          </Stack>
        </Stack>
      </div>

      <div className={styles.section}>
        <Stack gap={1} wrap="wrap" alignItems="flex-end">
          <Field label="Completed within" className={styles.field}>
            <Select
              width={16}
              options={WITHIN_OPTIONS}
              value={within}
              onChange={(v) => setSearchParams({ within: v.value, dropped: null })}
            />
          </Field>
          <Field label="Platform" className={styles.field}>
            <Select
              width={16}
              options={PLATFORM_OPTIONS}
              value={filters.platform ?? ''}
              onChange={(v) => setSearchParams({ platform: v.value, dropped: null })}
            />
          </Field>
          {TEXT_FILTERS.map((k) => (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)} className={styles.field}>
              <Input
                width={18}
                placeholder={`any ${k}`}
                value={text[k]}
                onChange={(e) => setText({ ...text, [k]: e.currentTarget.value })}
                onBlur={commitText}
                onKeyDown={(e) => e.key === 'Enter' && commitText()}
              />
            </Field>
          ))}
          <Field label="&nbsp;" className={styles.field}>
            <Button variant="secondary" icon="sync" onClick={funnel.reload} disabled={Boolean(problem)}>
              Refresh
            </Button>
          </Field>
        </Stack>
      </div>

      {problem && <Alert severity="info" title={problem} />}
      {suggestions.error && (
        <Alert severity="warning" title="Step suggestions unavailable">
          {suggestions.error.message}
        </Alert>
      )}
      {funnel.error && <ApiErrorAlert error={funnel.error} onRetry={funnel.reload} />}
      {!problem && funnel.loading && !funnel.data && <LoadingPlaceholder text="Computing funnel…" />}
      {!problem && funnel.data && funnel.data.sessions === 0 && !funnel.error && (
        <EmptyState variant="not-found" message="No session reached step 1">
          Try a wider time range, other filters or another first step.
        </EmptyState>
      )}
      {!problem && funnel.data && funnel.data.sessions > 0 && (
        <>
          <div className={styles.summary}>
            {funnel.data.sessions} sessions ({funnel.data.users} users) entered;{' '}
            {funnel.data.steps[funnel.data.steps.length - 1].sessions} completed (
            {funnel.data.steps[funnel.data.steps.length - 1].conversion_from_first.toFixed(1)}%). Click a hatched
            drop-off to list those sessions.
          </div>
          <FunnelChart
            steps={funnel.data.steps}
            selected={dropped}
            onDropOff={(n) => setSearchParams({ dropped: n === dropped ? null : n, offset: null })}
          />
        </>
      )}
      {!problem && dropped && dropped >= 2 && dropped <= steps.length && (
        <DroppedSessions
          step={dropped}
          stepsParam={stepsParam(steps)}
          range={range}
          within={within}
          filters={filters}
          offset={Number(search.get('offset') ?? 0) || 0}
          onPage={(offset) => setSearchParams({ offset: offset || null })}
          onClose={() => setSearchParams({ dropped: null, offset: null })}
        />
      )}
    </PluginPage>
  );
}

function textFrom(f: Partial<Record<TextFilter, string>>): Record<TextFilter, string> {
  return {
    environment: f.environment ?? '',
    release: f.release ?? '',
  };
}

const getStyles = (theme: GrafanaTheme2) => ({
  section: css({ marginBottom: theme.spacing(2) }),
  field: css({ marginBottom: 0 }),
  stepNo: css({
    width: theme.spacing(3),
    textAlign: 'center',
    color: theme.colors.text.secondary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  value: css({ minWidth: 280, flex: '0 1 420px' }),
  summary: css({ color: theme.colors.text.secondary }),
});
