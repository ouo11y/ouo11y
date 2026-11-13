import React, { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { type AppRootProps } from '@grafana/data';
import { ROUTES } from '../constants';
import { FeatureTogglesContext, parseFeatureToggles } from '../featureToggles';
import type { AppSettings } from './AppConfig';

const Overview = React.lazy(() => import('../pages/Overview'));
const Sessions = React.lazy(() => import('../pages/Sessions'));
const SessionDetail = React.lazy(() => import('../pages/SessionDetail'));
const Funnels = React.lazy(() => import('../pages/Funnels'));
const ExploreSessions = React.lazy(() => import('../explore/ExploreSessions'));
const ExploreSession = React.lazy(() => import('../explore/ExploreSession'));
const Home = React.lazy(() => import('../explore/Home'));
const Flows = React.lazy(() => import('../explore/Flows'));

export default function App({ meta }: AppRootProps<AppSettings>) {
  const toggles = useMemo(() => parseFeatureToggles(meta?.jsonData?.featureToggles), [meta?.jsonData?.featureToggles]);
  return (
    <FeatureTogglesContext.Provider value={toggles}>
      <Routes>
        <Route path={ROUTES.Overview} element={<Overview />} />
        <Route path={ROUTES.Sessions} element={<Sessions />} />
        <Route path={`${ROUTES.Sessions}/:id`} element={<SessionDetail />} />
        <Route path={ROUTES.Funnels} element={<Funnels />} />
        <Route path={ROUTES.Explore} element={<ExploreSessions />} />
        <Route path={`${ROUTES.Explore}/:project/:sessionId`} element={<ExploreSession />} />
        <Route path={ROUTES.Home} element={<Home />} />
        <Route path={ROUTES.Flows} element={<Flows />} />
        <Route path="*" element={<Navigate to={ROUTES.Home} replace />} />
      </Routes>
    </FeatureTogglesContext.Provider>
  );
}
