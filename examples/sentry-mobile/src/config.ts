import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";

interface Extra {
  sentryDsn: string;
  release: string;
  dist: string;
  environment: string;
  backendUrl: string;
  sentryDebug: boolean;
  ouoSdk: boolean;
  ouoOtlpEndpoint: string;
  ouoReplayEndpoint: string;
  ouoProjectId: string;
  ouoProjectToken: string;
  /** Built with OUO_PERF=1: Documents/perf-mode.json may switch the SDKs per launch (scripts/perf). */
  perfModes: boolean;
  /** Sentry.init runs (false only in a perf-mode launch "ouo only"). */
  sentry: boolean;
  /** ouo session replay (only read when ouoSdk). */
  ouoReplay: boolean;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  sentryDsn: extra.sentryDsn ?? "http://publickey0000000000000000000000@localhost:4400/1",
  release: extra.release ?? "sentry-demo@1.0.0+1",
  dist: extra.dist ?? "1",
  environment: extra.environment ?? "development",
  backendUrl: extra.backendUrl ?? "http://localhost:8082",
  sentryDebug: extra.sentryDebug ?? false,
  ouoSdk: extra.ouoSdk ?? false,
  ouoOtlpEndpoint: extra.ouoOtlpEndpoint ?? "http://localhost:4338",
  ouoReplayEndpoint: extra.ouoReplayEndpoint ?? "http://localhost:4339",
  ouoProjectId: extra.ouoProjectId ?? "demo",
  ouoProjectToken: extra.ouoProjectToken ?? "pt_dev_demo_0000000000000000",
  perfModes: extra.perfModes ?? false,
  sentry: true,
  ouoReplay: extra.ouoReplay ?? true,
};

// Overhead measurement (scripts/perf/run.sh): one binary, the SDK mix chosen per launch by
// Documents/perf-mode.json ({"sentry": bool, "ouo": bool, "ouoReplay": bool}), written by the
// harness before it launches the app. Read synchronously so it is known before Sentry.init.
if (config.perfModes) {
  try {
    const f = new File(Paths.document, "perf-mode.json");
    if (f.exists) {
      const m = JSON.parse(f.textSync()) as { sentry?: boolean; ouo?: boolean; ouoReplay?: boolean };
      config.sentry = m.sentry ?? config.sentry;
      config.ouoSdk = m.ouo ?? config.ouoSdk;
      config.ouoReplay = m.ouoReplay ?? config.ouoReplay;
    }
  } catch {
    // no or unreadable mode file: build defaults
  }
}
