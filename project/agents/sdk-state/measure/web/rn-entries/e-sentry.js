import * as Sentry from "@sentry/react-native"; globalThis.x = [Sentry.init, Sentry.reactNavigationIntegration, Sentry.mobileReplayIntegration, Sentry.wrap];
