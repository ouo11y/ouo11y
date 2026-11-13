// The datasource nested in the app plugin (ADR-0024). It exists for its backend: Grafana
// forwards the signed-in user's identity-provider tokens only to a datasource instance
// with jsonData.oauthPassThru, and the backend needs the ID token to decide Clearance. The
// app's pages call its resources (src/explore/bff.ts); it runs no dashboard queries and is
// configured by provisioning only.
import { DataSourceApi, DataSourcePlugin, type DataQueryResponse } from '@grafana/data';

class OuoDataSource extends DataSourceApi {
  async query(): Promise<DataQueryResponse> {
    return { data: [] };
  }
  async testDatasource() {
    return { status: 'success', message: 'Used by the ouo11y RUM app pages. It has no queries of its own.' };
  }
}

export const plugin = new DataSourcePlugin(OuoDataSource);
