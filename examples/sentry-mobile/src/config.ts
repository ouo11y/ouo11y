import Constants from "expo-constants";

interface Extra {
  sentryDsn: string;
  release: string;
  dist: string;
  environment: string;
  backendUrl: string;
  sentryDebug: boolean;
  ouoSdk: boolean;
  ouoReplay: boolean;
  ouoOtlpEndpoint: string;
  ouoReplayEndpoint: string;
  ouoProjectId: string;
  ouoProjectToken: string;
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
  ouoReplay: extra.ouoReplay ?? true,
  ouoOtlpEndpoint: extra.ouoOtlpEndpoint ?? "http://localhost:4338",
  ouoReplayEndpoint: extra.ouoReplayEndpoint ?? "http://localhost:4339",
  ouoProjectId: extra.ouoProjectId ?? "demo",
  ouoProjectToken: extra.ouoProjectToken ?? "pt_dev_demo_0000000000000000",
};
