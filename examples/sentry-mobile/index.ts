// Sentry must initialise before the first render so its error handlers, fetch tracing and
// replay are in place for everything the app does.
import "./src/sentry";
import * as Sentry from "@sentry/react-native";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(Sentry.wrap(App));
