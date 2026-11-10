// Expo config plugin: allow plain HTTP on Android.
//
// The local stack (deploy/compose, ouo-env) serves the collector and the demo backend over http on
// the Mac, which the emulator reaches as 10.0.2.2 and a phone as the Mac's LAN IP. Android blocks
// cleartext traffic by default since API 28, and Expo only lifts that for debug builds; the Release
// builds of scripts/build-android.sh need it too. A production app talks https and does not need it.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidCleartext(config) {
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application?.[0];
    if (app) app.$["android:usesCleartextTraffic"] = "true";
    return c;
  });
};
