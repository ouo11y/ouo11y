import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { type AppPluginMeta, type KeyValue, type PluginConfigPageProps, type PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, Input, SecretInput, Stack } from '@grafana/ui';
import { rumApi, RumApiError } from '../api/client';
import { DEFAULT_RUM_API_URL, RUM_PROXY_BASE } from '../constants';

export type AppSettings = {
  /** rum-api base URL as reachable from the Grafana server (not the browser). */
  rumApiUrl?: string;
};

/** Write-only secrets; Grafana returns only `secureJsonFields.<key> = true` once stored. */
export type AppSecureSettings = {
  /** Value of rum-api's OUO_READ_TOKEN; the route proxy sends it as `Authorization: Bearer`. */
  readToken?: string;
};

/** Body of POST /api/plugins/<id>/settings. Omitted secureJsonData keys keep their stored value. */
export type PluginSettingsBody = Pick<PluginMeta<AppSettings>, 'enabled' | 'pinned' | 'jsonData'> & {
  secureJsonData?: AppSecureSettings;
};

export type AppConfigProps = PluginConfigPageProps<AppPluginMeta<AppSettings>> & {
  /** Called after a successful save; defaults to a full page reload so Grafana re-reads the plugin meta. */
  onSaved?: () => void;
};

type Probe = { ok: true; status: 200 } | { ok: false; status?: number; message: string };

export type ConnectionTest = { healthz: Probe; stats: Probe };

async function probe(call: () => Promise<unknown>): Promise<Probe> {
  try {
    await call();
    return { ok: true, status: 200 };
  } catch (err) {
    if (err instanceof RumApiError) {
      return { ok: false, status: err.status, message: err.message };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Both probes go through the proxy with the *saved* settings; the token never leaves the server. */
export async function testConnection(): Promise<ConnectionTest> {
  const healthz = await probe(() => rumApi.healthz());
  const stats = await probe(() => rumApi.health({ from: 'now-1h' }));
  return { healthz, stats };
}

function reloadPage() {
  window.location.reload();
}

export default function AppConfig({ plugin, onSaved = reloadPage }: AppConfigProps) {
  const { enabled, pinned, jsonData } = plugin.meta;
  const secureJsonFields: KeyValue<boolean> = plugin.meta.secureJsonFields ?? {};
  const savedUrl = jsonData?.rumApiUrl ?? '';
  const [rumApiUrl, setRumApiUrl] = useState(savedUrl);
  const [readToken, setReadToken] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(Boolean(secureJsonFields.readToken));
  const [tokenReset, setTokenReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);

  const tokenDirty = !tokenConfigured && (readToken !== '' || tokenReset);
  const dirty = rumApiUrl !== savedUrl || tokenDirty;

  const settingsBody = (over: Partial<PluginSettingsBody> = {}): PluginSettingsBody => {
    const body: PluginSettingsBody = { enabled, pinned, jsonData: { rumApiUrl }, ...over };
    if (tokenDirty) {
      // Only send the secret when the user typed one (or reset a stored one); Grafana keeps the
      // stored value for every key that is absent from secureJsonData.
      body.secureJsonData = { readToken };
    }
    return body;
  };

  const save = async (body: PluginSettingsBody) => {
    setSaving(true);
    setError(null);
    try {
      await lastValueFrom(
        getBackendSrv().fetch({
          url: `/api/plugins/${plugin.meta.id}/settings`,
          method: 'POST',
          data: body,
          showErrorAlert: false,
          showSuccessAlert: false,
        })
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await testConnection());
    } finally {
      setTesting(false);
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
        <Field
          label="Read token"
          description="Value of OUO_READ_TOKEN in rum-api. Stored encrypted by Grafana (secureJsonData.readToken) and added server-side as the Authorization header on every proxied request; the browser never sees it. Leave empty when rum-api runs without a read token."
        >
          <SecretInput
            width={60}
            id="read-token"
            isConfigured={tokenConfigured}
            value={readToken}
            placeholder="paste the read token"
            onReset={() => {
              setTokenConfigured(false);
              setTokenReset(true);
              setReadToken('');
            }}
            onChange={(e) => setReadToken(e.currentTarget.value.trim())}
          />
        </Field>
        {error && (
          <Alert severity="error" title="Could not save settings">
            {error}
          </Alert>
        )}
        <Stack gap={1} alignItems="center">
          <Button disabled={saving} onClick={() => save(settingsBody())}>
            Save
          </Button>
          {!enabled && (
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => save(settingsBody({ enabled: true, pinned: true }))}
            >
              Enable plugin
            </Button>
          )}
          <Button variant="secondary" icon="heart-rate" disabled={testing} onClick={runTest}>
            Test connection
          </Button>
        </Stack>
      </FieldSet>
      <FieldSet label="Connection test">
        <p>
          Calls <code>{RUM_PROXY_BASE}/healthz</code> (open, proves the URL) and{' '}
          <code>{RUM_PROXY_BASE}/v1/stats/health?from=now-1h</code> (needs the read token) through the Grafana proxy
          with the <strong>saved</strong> settings.
          {dirty && <> You have unsaved changes; save first to test them.</>}
        </p>
        {test && <TestReport test={test} />}
      </FieldSet>
    </div>
  );
}

export function TestReport({ test }: { test: ConnectionTest }) {
  const { healthz, stats } = test;
  const reachable = healthz.ok;
  const tokenRejected = !stats.ok && stats.status === 401;
  const title = !reachable
    ? 'rum-api not reachable'
    : tokenRejected
      ? 'read token rejected by rum-api'
      : stats.ok
        ? 'rum-api reachable, read token accepted'
        : 'rum-api reachable, stats request failed';
  const severity = reachable && stats.ok ? 'success' : tokenRejected ? 'warning' : 'error';
  return (
    <Alert severity={severity} title={title} data-testid="connection-test">
      <div data-testid="probe-healthz">
        <code>GET {RUM_PROXY_BASE}/healthz</code>:{' '}
        {healthz.ok ? 'HTTP 200, the proxy reaches rum-api at the configured URL.' : healthz.message}
      </div>
      <div data-testid="probe-stats">
        <code>GET {RUM_PROXY_BASE}/v1/stats/health?from=now-1h</code>:{' '}
        {stats.ok
          ? 'HTTP 200, rum-api accepted the read token.'
          : tokenRejected
            ? 'HTTP 401, rum-api rejected the read token. Paste the OUO_READ_TOKEN value rum-api runs with into "Read token", save, and test again. If rum-api runs without OUO_READ_TOKEN it never answers 401.'
            : stats.message}
      </div>
    </Alert>
  );
}
