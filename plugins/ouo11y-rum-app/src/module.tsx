import React, { Suspense, lazy } from 'react';
import { AppPlugin } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps, AppSettings } from './components/AppConfig';

const App = lazy(() => import('./components/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig'));

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

export const plugin = new AppPlugin<AppSettings>().setRootPage(App).addConfigPage({
  title: 'Configuration',
  icon: 'cog',
  body: AppConfig,
  id: 'configuration',
});
