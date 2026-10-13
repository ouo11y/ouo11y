import Constants from "expo-constants";

interface Extra {
  sentryDsn: string;
  release: string;
  dist: string;
  environment: string;
  backendUrl: string;
  sentryDebug: boolean;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  sentryDsn: extra.sentryDsn ?? "http://publickey0000000000000000000000@localhost:4400/1",
  release: extra.release ?? "sentry-demo@1.0.0+1",
  dist: extra.dist ?? "1",
  environment: extra.environment ?? "development",
  backendUrl: extra.backendUrl ?? "http://localhost:8082",
  sentryDebug: extra.sentryDebug ?? false,
};
