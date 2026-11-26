// ouo RUM for React Native: sessions, taps, screens, errors, crashes, vitals, fetch spans and
// screenshot replay, sent as OTLP to the collector of guide 00.
import { initRUM } from "@ouo11y/react-native";

export const rum = initRUM({
  // The iOS Simulator reaches your Mac as localhost. A phone needs your Mac's LAN address.
  endpoint: process.env.EXPO_PUBLIC_OUO_ENDPOINT ?? "http://localhost:4318",
  projectId: "demo",                             // a line of stack/10-collector/projects.htpasswd
  projectToken: "pt_dev_demo_0000000000000000",  // public: it can only write into project demo
  service: { name: "tiny-shop-mobile", version: "1.0.0", environment: "local" },
  replay: { enabled: true, mode: "pixel/frames", maskText: false }, // needs a development build
  debug: __DEV__,
});
