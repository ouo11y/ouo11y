// Where the app sends its requests and its Sentry envelopes. Expo inlines EXPO_PUBLIC_* variables
// into the JS bundle when Metro builds it: set them in app/.env and restart Metro to change them.

// The Tiny Shop API (backend/). The simulator reaches your Mac on localhost.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

// A Sentry DSN whose host is the ouo collector's Sentry bridge (stack/10-collector, port 4320).
// `publickey0000000000000000000000` and project `1` are the pair the bridge's `projects` table
// lists; they are public, local use only. Never put a sentry.io DSN here for this quickstart.
export const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1";
