import { initRUM, type RUM } from "@ouo11y/react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

interface Extra {
  backendUrl: string;
  /** Collector OTLP/HTTP base URL (ADR-0007); replay chunks go to the same host on port 4319. */
  otlpEndpoint: string;
  /** Optional replay receiver base URL; unset derives port 4319 from 4318 (ADR-0007 section 6). */
  replayEndpoint?: string;
  /** Project credential (HTTP Basic: id is the user name, token the password). Public by nature; the stock compose stack ships this development project. */
  projectId: string;
  projectToken: string;
  environment: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  backendUrl: extra.backendUrl ?? "http://localhost:8081",
  otlpEndpoint: extra.otlpEndpoint ?? "http://localhost:4318",
  ...(extra.replayEndpoint ? { replayEndpoint: extra.replayEndpoint } : {}),
  projectId: extra.projectId ?? "demo",
  projectToken: extra.projectToken ?? "pt_dev_demo_0000000000000000",
  environment: extra.environment ?? "local",
};

/** `service.version` is the app version from app.config.ts (APP_VERSION env). */
export const appVersion = Constants.expoConfig?.version ?? "0.0.0";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const rum: RUM = initRUM({
  endpoint: config.otlpEndpoint,
  // Unset replayEndpoint is derived: http://localhost:4318 -> http://localhost:4319 (ADR-0007 section 6).
  ...(config.replayEndpoint ? { replayEndpoint: config.replayEndpoint } : {}),
  projectId: config.projectId,
  projectToken: config.projectToken,
  service: { name: "mobile-store", version: appVersion, environment: config.environment },
  tracing: { propagateTo: [new RegExp(`^${escapeRegExp(config.backendUrl)}`)] },
  device: {
    ...(Device.modelId ? { modelIdentifier: String(Device.modelId) } : {}),
    ...(Device.modelName ? { modelName: Device.modelName } : {}),
    ...(Device.manufacturer ? { manufacturer: Device.manufacturer } : {}),
    ...(Device.osName ? { osName: Device.osName } : {}),
    ...(Device.osVersion ? { osVersion: Device.osVersion } : {}),
  },
  // Native session replay (ADR-0006): needs the development build (npx expo run:ios); a no-op
  // in Expo Go and on web. Chunks go to `${replayEndpoint}/v1/replay/chunks` with the Basic credential.
  // The demo opts out of label masking (maskText: false) so replays are readable; text inputs
  // stay masked (maskInputs defaults to true), as do images and web views. The promo field is
  // additionally marked testID="ouo-mask" and the product title testID="ouo-unmask".
  replay: { enabled: true, maskText: false },
  debug: __DEV__,
});

export const shortId = (id: string): string => id.slice(0, 8);
