import React, { useEffect, useMemo } from 'react';
import { Combobox, type ComboboxOption, Icon, Stack, Tooltip } from '@grafana/ui';
import { rumApi } from '../api/client';
import type { ProjectsResponse } from '../api/types';
import { useRumQuery } from '../hooks/useRumQuery';
import { setSearchParams } from '../hooks/useSearchParams';
import { loadScope, reconcileScope, saveScope, useScope, type Scope } from '../hooks/useScope';
import { toTimeRange, type RawRange } from '../utils/timerange';
import { useRawRange } from './TimeRangeBar';

export const ALL_PROJECTS = 'All projects';
export const ALL_APPS = 'All apps';

/** Value of the "All projects" option (not a valid project id, so it never collides). */
export const ALL_PROJECTS_VALUE = '*';

/** Separates project and app in an app option's value (neither may contain it: project ids are [a-z0-9._-]). */
const SEP = '\u0000';

export function appValue(project: string, service: string): string {
  return `${project}${SEP}${service}`;
}

/**
 * Project options: "All projects" first, then every project in the response. The current project
 * stays listed when it has no session in the range, so the picker never shows a blank value.
 */
export function projectOptions(data: ProjectsResponse | undefined, scope: Scope): Array<ComboboxOption<string>> {
  const out: Array<ComboboxOption<string>> = [{ label: ALL_PROJECTS, value: ALL_PROJECTS_VALUE }];
  for (const p of data?.projects ?? []) {
    out.push({
      label: p.project_id,
      value: p.project_id,
      description: `${p.apps.length} app${p.apps.length === 1 ? '' : 's'}, ${p.sessions} session${p.sessions === 1 ? '' : 's'}`,
    });
  }
  if (scope.project && !out.some((o) => o.value === scope.project)) {
    out.push({ label: scope.project, value: scope.project, description: 'no sessions in range' });
  }
  return out;
}

/**
 * App options: "All apps" first, then the apps of the selected project, or of every project when
 * the project is "all" (labelled `app · project`, and picking one also sets the project).
 */
export function appOptions(data: ProjectsResponse | undefined, scope: Scope): Array<ComboboxOption<string>> {
  const out: Array<ComboboxOption<string>> = [{ label: ALL_APPS, value: appValue(scope.project, '') }];
  for (const p of data?.projects ?? []) {
    if (scope.project && p.project_id !== scope.project) {
      continue;
    }
    for (const a of p.apps) {
      out.push({
        label: scope.project ? a.service_name : `${a.service_name} · ${p.project_id}`,
        value: appValue(p.project_id, a.service_name),
        description: `${a.platforms.join(', ') || 'unknown platform'}, ${a.sessions} session${a.sessions === 1 ? '' : 's'}`,
      });
    }
  }
  if (scope.service && !out.some((o) => o.value === appValue(scope.project, scope.service))) {
    out.push({
      label: scope.project ? scope.service : `${scope.service} · all projects`,
      value: appValue(scope.project, scope.service),
      description: scope.project ? 'no sessions in range' : 'this app name in every project',
    });
  }
  return out;
}

/**
 * The scope after picking a project: the app is kept only when the new project has it (picking
 * "All projects" keeps it, as an app filter across projects).
 */
export function pickProject(data: ProjectsResponse | undefined, scope: Scope, value: string): Scope {
  const project = value === ALL_PROJECTS_VALUE ? '' : value;
  if (!project || !scope.service) {
    return { project, service: scope.service };
  }
  const p = data?.projects.find((x) => x.project_id === project);
  const has = Boolean(p?.apps.some((a) => a.service_name === scope.service));
  return { project, service: has ? scope.service : '' };
}

export function pickApp(value: string): Scope {
  const i = value.indexOf(SEP);
  if (i < 0) {
    return { project: '', service: value };
  }
  return { project: value.slice(0, i), service: value.slice(i + 1) };
}

/** URL updates when the scope changes; paging and funnel drop-off state belong to the old scope. */
function applyScope(next: Scope) {
  // Stored before the URL changes, so picking All projects / All apps is not undone by the restore.
  saveScope(next);
  setSearchParams({ project: next.project, service: next.service, dropped: null, offset: null });
}

/** rum-api's GET /v1/projects allows 720 h; a longer page range asks for its last 30 days. */
export const MAX_PROJECTS_RANGE_MS = 30 * 24 * 3600 * 1000;

export function projectsRange(raw: RawRange): RawRange {
  const r = toTimeRange(raw);
  const to = r.to.valueOf();
  if (to - r.from.valueOf() <= MAX_PROJECTS_RANGE_MS) {
    return raw;
  }
  return { from: new Date(to - MAX_PROJECTS_RANGE_MS).toISOString(), to: raw.to };
}

/**
 * Project and app selector shared by every page. The state is the URL (`project`, `service`), so
 * links between pages keep it; "All projects" / "All apps" is the cross-project view. It narrows
 * what is shown and is not an access boundary.
 */
export function ScopePicker() {
  const scope = useScope();
  const range = useRawRange();
  const { data, loading, error } = useRumQuery(
    () => rumApi.projects({ ...projectsRange(range) }),
    `${range.from}|${range.to}|projects`
  );
  // Remember the scope per org, and bring it back on a page opened without one (nav menu links).
  useEffect(() => {
    const { save, restore } = reconcileScope(scope, loadScope());
    if (save) {
      saveScope(save);
    } else if (restore) {
      setSearchParams({ project: restore.project, service: restore.service }, true);
    }
  }, [scope]);
  const projects = useMemo(() => projectOptions(data, scope), [data, scope]);
  const apps = useMemo(() => appOptions(data, scope), [data, scope]);

  return (
    <Stack gap={1} alignItems="center" data-testid="scope-picker">
      <Combobox
        aria-label="Project"
        data-testid="scope-project"
        width={24}
        prefixIcon="folder"
        options={projects}
        value={scope.project || ALL_PROJECTS_VALUE}
        loading={loading}
        onChange={(o) => applyScope(pickProject(data, scope, o.value))}
      />
      <Combobox
        aria-label="App"
        data-testid="scope-app"
        width={30}
        prefixIcon="apps"
        options={apps}
        value={appValue(scope.project, scope.service)}
        loading={loading}
        onChange={(o) => applyScope(pickApp(o.value))}
      />
      {error && (
        <Tooltip content={`Project list unavailable: ${error.message}`}>
          <span data-testid="scope-error" aria-label="Project list unavailable">
            <Icon name="exclamation-triangle" />
          </span>
        </Tooltip>
      )}
      <Tooltip content="Scopes every page to one project or app. It narrows what you see; it is not an access boundary: everyone with access to this app can pick any project.">
        <span data-testid="scope-info" aria-label="About the project selector">
          <Icon name="info-circle" />
        </span>
      </Tooltip>
    </Stack>
  );
}
