// Sentry's Metro config: adds a debug id to the bundle, which Sentry matches to uploaded source maps.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
