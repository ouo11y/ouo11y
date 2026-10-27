// Sentry first, so it sees the app start and every error after it.
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

// Sentry.wrap: tap breadcrumbs (TouchEventBoundary) and the app start measurement.
registerRootComponent(Sentry.wrap(App));
