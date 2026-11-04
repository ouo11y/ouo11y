import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { of, throwError } from 'rxjs';
import type { AppPluginMeta } from '@grafana/data';
import AppConfig, { type AppConfigProps, type AppSettings } from './AppConfig';

const fetchMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: fetchMock }),
  isFetchError: (e: unknown) => typeof e === 'object' && e !== null && 'status' in e && 'data' in e,
}));

function meta(over: Partial<AppPluginMeta<AppSettings>> = {}): AppPluginMeta<AppSettings> {
  return {
    id: 'ouo11y-rum-app',
    name: 'ouo11y RUM',
    type: 'app',
    module: 'plugins/ouo11y-rum-app/module',
    baseUrl: 'public/plugins/ouo11y-rum-app',
    info: {
      author: { name: 'ouo' },
      description: '',
      links: [],
      logos: { small: '', large: '' },
      screenshots: [],
      updated: '',
      version: '0.3.0',
    },
    enabled: true,
    pinned: true,
    jsonData: { rumApiUrl: '' },
    secureJsonFields: {},
    ...over,
  } as AppPluginMeta<AppSettings>;
}

function renderConfig(m: AppPluginMeta<AppSettings>, onSaved = jest.fn()) {
  const plugin = { meta: m } as unknown as AppConfigProps['plugin'];
  render(<AppConfig plugin={plugin} query={{}} onSaved={onSaved} />);
  return onSaved;
}

/** Field's <label> text includes the description, so inputs are looked up by id. */
const input = (id: string) => {
  const el = document.getElementById(id);
  expect(el).not.toBeNull();
  return el as HTMLInputElement;
};

const postedBody = () => {
  const call = fetchMock.mock.calls.find(([opts]) => opts.method === 'POST');
  expect(call).toBeDefined();
  return call![0];
};

describe('AppConfig', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockReturnValue(of({ data: {} }));
  });

  it('saves rumApiUrl in jsonData and a new read token in secureJsonData', async () => {
    const onSaved = renderConfig(meta());
    fireEvent.change(input('rum-api-url'), { target: { value: 'http://rum-api:9090' } });
    fireEvent.change(input('read-token'), { target: { value: 'rt_dev_token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({
      url: '/api/plugins/ouo11y-rum-app/settings',
      method: 'POST',
      data: {
        enabled: true,
        pinned: true,
        jsonData: { rumApiUrl: 'http://rum-api:9090' },
        secureJsonData: { readToken: 'rt_dev_token' },
      },
    });
  });

  it('saves rumApiUrl without a trailing slash (the POST and DELETE routes append /v1/...)', async () => {
    const onSaved = renderConfig(meta());
    fireEvent.change(input('rum-api-url'), { target: { value: 'http://rum-api:9090//' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(postedBody().data.jsonData).toEqual({ rumApiUrl: 'http://rum-api:9090' });
  });

  it('does not send secureJsonData when no token was typed', async () => {
    const onSaved = renderConfig(meta());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(postedBody().data).toEqual({ enabled: true, pinned: true, jsonData: { rumApiUrl: '' } });
  });

  it('shows a configured token as write-only and keeps it unless reset', async () => {
    const onSaved = renderConfig(meta({ secureJsonFields: { readToken: true } }));
    const field = input('read-token');
    expect(field).toBeDisabled();
    expect(field).toHaveValue('configured');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(postedBody().data).not.toHaveProperty('secureJsonData');

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.change(input('read-token'), { target: { value: 'rt_rotated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(postedBody().data.secureJsonData).toEqual({ readToken: 'rt_rotated' });
  });

  it('reports a rejected read token from the connection test', async () => {
    fetchMock.mockImplementation(({ url }: { url: string }) =>
      url.endsWith('/rum/healthz')
        ? of({ data: { status: 'ok' } })
        : throwError(() => ({ status: 401, statusText: 'Unauthorized', data: { error: 'unauthorized' } }))
    );
    renderConfig(meta({ secureJsonFields: { readToken: true } }));
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    const report = await screen.findByTestId('connection-test');
    expect(report).toHaveTextContent('read token rejected by rum-api');
    expect(screen.getByTestId('probe-healthz')).toHaveTextContent('HTTP 200');
    expect(screen.getByTestId('probe-stats')).toHaveTextContent('HTTP 401');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/plugin-proxy/ouo11y-rum-app/rum/healthz' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/plugin-proxy/ouo11y-rum-app/rum/v1/stats/health?from=now-1h' })
    );
  });

  it('keeps the provisioned feature toggles in jsonData when it saves, and lists their state (B1)', async () => {
    const onSaved = renderConfig(meta({ jsonData: { rumApiUrl: '', featureToggles: 'sessionTimelinePanel' } }));
    expect(screen.getByTestId('feature-toggles')).toHaveTextContent('sessionTimelinePanel: on.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(postedBody().data.jsonData).toEqual({ rumApiUrl: '', featureToggles: 'sessionTimelinePanel' });
  });

  it('lists every toggle as off when none is set', () => {
    renderConfig(meta());
    expect(screen.getByTestId('feature-toggles')).toHaveTextContent('sessionTimelinePanel: off.');
  });

  it('reports success when both probes answer 200', async () => {
    renderConfig(meta());
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    const report = await screen.findByTestId('connection-test');
    expect(report).toHaveTextContent('rum-api reachable, read token accepted');
  });
});
