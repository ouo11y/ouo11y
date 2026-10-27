// Sentry first: it must start before React Native renders anything, or the app start
// and the first screen's TTID are not measured.
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

// Sentry.wrap adds touch breadcrumbs and the error boundary around the whole app.
registerRootComponent(Sentry.wrap(App));
