import { initRUM, type RUM } from "@ouo11y/react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

interface Extra {
  backendUrl: string;
  /** Collector OTLP/HTTP base URL (ADR-0007); replay chunks go to `${otlpEndpoint}/v1/logs` as OTLP log records (ADR-0021). */
  otlpEndpoint: string;
  /** Project credential (HTTP Basic: id is the user name, token the password). Public by nature; the stock compose stack ships this development project. */
  projectId: string;
  projectToken: string;
  environment: string;
  /** The golden app of the Android conformance suite (OUO_CONFORMANCE=1, app.config.ts). */
  conformance?: boolean;
  /** The SDK's debug log in a Release build (OUO_DEBUG=1, app.config.ts). */
  debug?: boolean;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  backendUrl: extra.backendUrl ?? "http://localhost:8081",
  otlpEndpoint: extra.otlpEndpoint ?? "http://localhost:4318",
  projectId: extra.projectId ?? "demo",
  projectToken: extra.projectToken ?? "pt_dev_demo_0000000000000000",
  environment: extra.environment ?? "local",
  conformance: extra.conformance === true,
  debug: extra.debug === true,
};

/** `service.version` is the app version from app.config.ts (APP_VERSION env). */
export const appVersion = Constants.expoConfig?.version ?? "0.0.0";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const rum: RUM = initRUM({
  endpoint: config.otlpEndpoint,
  projectId: config.projectId,
  projectToken: config.projectToken,
  service: { name: "mobile-store", version: appVersion, environment: config.environment },
  tracing: { propagateTo: [new RegExp(`^${escapeRegExp(config.backendUrl)}`)] },
  // The demo backend puts the session id on its own spans and logs: it reads it from W3C baggage.
  propagation: { sessionBaggage: true },
  device: {
    ...(Device.modelId ? { modelIdentifier: String(Device.modelId) } : {}),
    ...(Device.modelName ? { modelName: Device.modelName } : {}),
    ...(Device.manufacturer ? { manufacturer: Device.manufacturer } : {}),
    ...(Device.osName ? { osName: Device.osName } : {}),
    ...(Device.osVersion ? { osVersion: Device.osVersion } : {}),
  },
  // Native session replay (ADR-0021 decision 5): needs the development build (npx expo run:ios);
  // a no-op in Expo Go and on web. `mode` is what is recorded (`pixel/frames`: masked frames and
  // tile patches). Each chunk is one OTLP log record (`ouo.replay.chunk`) the native module posts
  // to `${endpoint}/v1/logs` with the Basic credential, from its own disk queue.
  // The demo opts out of label masking (maskText: false) so replays are readable; text inputs
  // stay masked (maskInputs defaults to true), as do images and web views. The promo field is
  // additionally marked testID="ouo-mask" and the product title testID="ouo-unmask".
  // The conformance build keeps every default (spec C8.2: text, inputs, images and web views
  // masked) and ends a session after 5 s in the background (C1.1 without a 30 s wait).
  replay: config.conformance ? { enabled: true, mode: "pixel/frames" } : { enabled: true, mode: "pixel/frames", maskText: false },
  ...(config.conformance ? { session: { backgroundTimeoutMs: 5000 } } : {}),
  debug: __DEV__ || config.debug === true,
});

/**
 * A line for the Android conformance suite (tests/e2e/mobile-android/check.mjs), which reads them from
 * logcat: `OUO_NOTE {"kind": ..., "ts": ..., "session": ...}`. Nothing outside the conformance build.
 */
export function note(kind: string, fields: Record<string, unknown> = {}): void {
  if (!config.conformance) return;
  console.log(`OUO_NOTE ${JSON.stringify({ kind, ts: Date.now(), session: rum.session.id(), ...fields })}`);
}

export const shortId = (id: string): string => id.slice(0, 8);
