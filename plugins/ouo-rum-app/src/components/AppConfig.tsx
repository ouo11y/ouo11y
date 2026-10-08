import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { type AppPluginMeta, type PluginConfigPageProps, type PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, Input } from '@grafana/ui';
import { DEFAULT_RUM_API_URL, RUM_PROXY_BASE } from '../constants';

export type AppSettings = {
  /** rum-api base URL as reachable from the Grafana server (not the browser). */
  rumApiUrl?: string;
};

export type AppConfigProps = PluginConfigPageProps<AppPluginMeta<AppSettings>>;

export default function AppConfig({ plugin }: AppConfigProps) {
  const { enabled, pinned, jsonData } = plugin.meta;
  const [rumApiUrl, setRumApiUrl] = useState(jsonData?.rumApiUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Partial<PluginMeta<AppSettings>>) => {
    setSaving(true);
    setError(null);
    try {
      await lastValueFrom(
        getBackendSrv().fetch({
          url: `/api/plugins/${plugin.meta.id}/settings`,
          method: 'POST',
          data: next,
          showErrorAlert: false,
        })
      );
      // Plugin meta is read at page load; reload so the new route URL is picked up.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div data-testid="app-config">
      <FieldSet label="rum-api">
        <Field
          label="rum-api URL"
          description={`Base URL of rum-api as seen from the Grafana server. Empty means ${DEFAULT_RUM_API_URL} (the compose service). The browser calls ${RUM_PROXY_BASE}/v1/... and Grafana proxies it there.`}
        >
          <Input
            width={60}
            id="rum-api-url"
            value={rumApiUrl}
            placeholder={DEFAULT_RUM_API_URL}
            onChange={(e) => setRumApiUrl(e.currentTarget.value.trim())}
          />
        </Field>
        {error && (
          <Alert severity="error" title="Could not save settings">
            {error}
          </Alert>
        )}
        <Button disabled={saving} onClick={() => save({ enabled, pinned, jsonData: { rumApiUrl } })}>
          Save
        </Button>
        {!enabled && (
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => save({ enabled: true, pinned: true, jsonData: { rumApiUrl } })}
            style={{ marginLeft: 8 }}
          >
            Enable plugin
          </Button>
        )}
      </FieldSet>
    </div>
  );
}
