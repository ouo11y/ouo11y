# React Native bundle size

The JavaScript that `@ouo11y/react-native` and `@sentry/react-native` 8.34.0 add to an app bundle, minified, with React Native, React and the Expo packages left external. Native code is measured by the [iOS](../ios/README.md) and [Android](../android/README.md) harnesses. Written for Step 5 ([overhead.md](../../../../kb/client-sdk-state/overhead.md)).

It has its own folder and dependencies: installed next to `@sentry/browser` 11 (the web harness), `@sentry/react-native` would resolve part of a second Sentry core and measure 13 KiB larger.

```bash
npm ci && npm run build -w sdk/react-native        # at the repo root
npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts
mkdir -p node_modules/@ouo11y
ln -sfn ../../../../../../../sdk/react-native node_modules/@ouo11y/react-native
node rn-bundle.mjs                                 # writes results/rn-bundle.json
```

esbuild stands in for Metro: it shows the size of the code each SDK brings, not Hermes bytecode size.
