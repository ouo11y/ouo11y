import Constants from "expo-constants";

type RumMode = "sentry" | "parallel" | "ouo";

interface Extra {
  sentryDsn: string;
  release: string;
  dist: string;
  environment: string;
  backendUrl: string;
  sentryDebug: boolean;
  sentryDirectDsn: string;
  defaultMode: RumMode;
  flagProvider: "ofrep" | "memory";
  flagUrl: string;
  flagTimeoutMs: number;
  flagMemoryMode: RumMode;
  ouoOtlpEndpoint: string;
  ouoReplayEndpoint: string;
  ouoProjectId: string;
  ouoProjectToken: string;
  /**
   * Built with OUO_PERF=1: Documents/perf-mode.json overrides the rollout mode per launch
   * (scripts/perf, src/rollout.ts) and src/perf.ts records JS frames.
   */
  perfModes: boolean;
  /** SENTRY_CAPTURE_ALL=1: screenshot, view hierarchy, profiles, failed requests (src/sentry.ts). */
  sentryCaptureAll: boolean;
  /** SENTRY_REPLAY_MASK=default: Sentry's default replay masking instead of the demo's unmasked replay. */
  replayMaskDefault: boolean;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  sentryDsn: extra.sentryDsn ?? "http://publickey0000000000000000000000@localhost:4400/1",
  release: extra.release ?? "sentry-demo@1.0.0+1",
  dist: extra.dist ?? "1",
  environment: extra.environment ?? "development",
  backendUrl: extra.backendUrl ?? "http://localhost:8082",
  sentryDebug: extra.sentryDebug ?? false,
  sentryDirectDsn: extra.sentryDirectDsn ?? "http://publickey0000000000000000000000@localhost:4401/1",
  defaultMode: extra.defaultMode ?? "sentry",
  flagProvider: extra.flagProvider ?? "ofrep",
  flagUrl: extra.flagUrl ?? "http://localhost:8016",
  flagTimeoutMs: extra.flagTimeoutMs ?? 1500,
  flagMemoryMode: extra.flagMemoryMode ?? "sentry",
  ouoOtlpEndpoint: extra.ouoOtlpEndpoint ?? "http://localhost:4338",
  ouoReplayEndpoint: extra.ouoReplayEndpoint ?? "http://localhost:4339",
  ouoProjectId: extra.ouoProjectId ?? "demo",
  ouoProjectToken: extra.ouoProjectToken ?? "pt_dev_demo_0000000000000000",
  perfModes: extra.perfModes ?? false,
  sentryCaptureAll: extra.sentryCaptureAll ?? false,
  replayMaskDefault: extra.replayMaskDefault ?? false,
};
