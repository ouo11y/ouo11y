// ouo RUM, set up before the first render (index.ts imports this file first), so the error
// handlers and the fetch wrapper exist before the app does anything.
import { initRUM } from "@ouo11y/react-native";
import Constants from "expo-constants";

// The ouo collector's OTLP/HTTP port. From the iOS Simulator, localhost is your Mac.
// Replay frames go to its replay port: the SDK derives 4319 from 4318, and only from 4318, so
// when you move the collector's ports set both variables.
const endpoint = process.env.EXPO_PUBLIC_OUO_ENDPOINT ?? "http://localhost:4318";
const replayEndpoint = process.env.EXPO_PUBLIC_OUO_REPLAY_ENDPOINT;
export const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const rum = initRUM({
  endpoint,
  replayEndpoint,
  // The quickstart's `demo` project. The token only allows writing telemetry: it is public by
  // nature, like every RUM key, and ships in the app bundle.
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000",
  service: { name: "tiny-shop-mobile", version: Constants.expoConfig?.version ?? "0.0.0", environment: "local" },
  // Requests to the API get `traceparent` and `baggage` (session.id, user.id): the API joins the trace.
  tracing: { propagateTo: [new RegExp(`^${escape(apiUrl)}`)] },
  // Native replay (Release builds; a no-op in Expo Go). Everything is masked by default;
  // this shop shows labels so the replay is readable, and keeps inputs and images masked.
  replay: { enabled: true, maskText: false },
  debug: __DEV__,
});
