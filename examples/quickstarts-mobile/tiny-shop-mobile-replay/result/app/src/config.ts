// Everything the app needs to know about where it sends data. EXPO_PUBLIC_* variables are written
// into the JavaScript bundle when Metro builds it: after changing one, rebuild the app.
export const config = {
  // The Tiny Shop API (backend/).
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001",
  // The ouo Sentry bridge, in Sentry DSN form: http://<public key>@<host>:<port>/<project id>.
  // The key and project id must match stack/10-collector/config.yaml. Never a sentry.io DSN here.
  sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1",
  // Share of sessions recorded from the start (1 = all, 0.1 = one in ten).
  replaySessionRate: Number(process.env.EXPO_PUBLIC_REPLAY_SESSION_RATE ?? "1"),
  // Share of the other sessions whose last minute is sent when an error happens.
  replayOnErrorRate: Number(process.env.EXPO_PUBLIC_REPLAY_ON_ERROR_RATE ?? "1"),
  // "on" (Sentry's default): every text, image and icon is a box in the replay. "off": the screen as it is.
  replayMasking: process.env.EXPO_PUBLIC_REPLAY_MASKING !== "off",
};
