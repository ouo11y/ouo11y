// Sentry must initialise before the first render so its error handlers, fetch tracing and
// replay are in place for everything the app does.
import "./src/sentry";
// Parallel mode (OUO_SDK=1): ouo initialises AFTER Sentry, so it owns Hermes' single promise
// rejection tracker (and forwards rejections to Sentry) and its fetch / XHR wrappers run first,
// so ouo's traceparent is the one the backend gets. A no-op without OUO_SDK=1.
import "./src/ouo";
import * as Sentry from "@sentry/react-native";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(Sentry.wrap(App));
