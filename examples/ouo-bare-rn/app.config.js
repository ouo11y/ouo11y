// Read at build time by expo-constants (its Xcode script phase and Gradle task embed the result), so
// the golden app's src/rum.ts gets the same `extra` as on Expo 57 (../ouo-mobile/app.config.ts). Only
// the example needs it: a client app passes its endpoint and credential to initRUM however it likes.
// Same variables as ../ouo-mobile: EXPO_PUBLIC_OTLP_ENDPOINT, EXPO_PUBLIC_OUO_REPLAY_ENDPOINT,
// EXPO_PUBLIC_OUO_PROJECT_ID / _TOKEN, BACKEND_URL, APP_VERSION, OUO_ENV, OUO_CONFORMANCE=1.
module.exports = ({ config }) => ({
  ...config, // app.json: name (the AppRegistry component) and displayName
  slug: "ouo-bare-rn",
  version: process.env.APP_VERSION ?? "2.3.0",
  extra: {
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:8081",
    otlpEndpoint: process.env.EXPO_PUBLIC_OTLP_ENDPOINT ?? "http://localhost:4318",
    replayEndpoint: process.env.EXPO_PUBLIC_OUO_REPLAY_ENDPOINT || undefined,
    projectId: process.env.EXPO_PUBLIC_OUO_PROJECT_ID ?? "demo",
    projectToken: process.env.EXPO_PUBLIC_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    environment: process.env.OUO_ENV ?? "local",
    conformance: process.env.OUO_CONFORMANCE === "1",
  },
});
