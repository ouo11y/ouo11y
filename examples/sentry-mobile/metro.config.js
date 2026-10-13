// Sentry's Metro wrapper adds debug ids to the bundle (what a real Sentry Expo app ships).
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
