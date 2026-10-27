// Where the app sends its data, and the release it reports. EXPO_PUBLIC_* variables are read
// when Metro bundles the app: set them in app/.env (or the shell) and restart Metro.

// The ouo Sentry bridge, not sentry.io: http://<public key>@<bridge host>/<Sentry project id>.
// The stack's bridge accepts this public key for project 1. On the Simulator, localhost is your Mac.
export const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1";

// The Tiny Shop API (backend/).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

// Keep these in step with "version" and "ios.buildNumber" in app.json.
const VERSION = "1.0.0";
const BUILD = "1";

// release = <package>@<version>+<build>. The bridge turns it into service.version 1.0.0 and
// ouo.app.build 1 on every record; dist is the build again, as Sentry expects it.
export const RELEASE = `tiny-shop-mobile-signals@${VERSION}+${BUILD}`;
export const DIST = BUILD;
export const ENVIRONMENT = process.env.EXPO_PUBLIC_ENVIRONMENT ?? "development";
