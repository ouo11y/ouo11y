// Sentry first, so it is running before anything else loads; then the app, wrapped by Sentry
// (touch breadcrumbs, and the root component's errors).
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(Sentry.wrap(App));
