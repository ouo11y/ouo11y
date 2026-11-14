# @ouo11y/sourcemaps

`ouo-sourcemaps` makes errors from minified production bundles, web and React Native (Hermes), readable in ouo. It adds a debug id to every built bundle and uploads the source maps (and iOS dSYMs) straight to Muninn's public upload route; stacks are symbolicated when they are read, by `ouo-go/symbolicate` in the plugin backend ([ADR-0011](../../docs/adr-archive/0011-source-maps-and-symbolication.md), [ADR-0026](../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md)).

```bash
npm install --save-dev @ouo11y/sourcemaps

# after the build, before deploying
npx ouo-sourcemaps inject dist
npx ouo-sourcemaps upload dist --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" \
  --project web-store --release "$APP_VERSION" --delete-after
```

- `inject <dir>...` appends `//# debugId=<uuid>` to each `.js` / `.mjs` / `.cjs` file that has a map, together with a one-line snippet that tells `@ouo11y/browser` the id at runtime. It writes the same id into the map. It is idempotent, and no existing mapping moves. React Native bundles (`.bundle`, `.jsbundle`, or any file with `--react-native`) get the React Native snippet, which survives Hermes compilation: inject them before `hermesc`.
- `upload <dir>...` PUTs each map, gzip-compressed, to `<url>/api/v1/projects/<project>/debug-files/sourcemap/<debug id>` with the project's **upload token**. `<url>` is Muninn's public base URL and `--project` is required. The token is a CI secret, set in Muninn's `debug_files.upload_tokens`; it is not the public project token the SDK ships with. Bundles are `.js`, `.mjs`, `.cjs`, `.bundle`, `.jsbundle` and `.hbc` files with a map; the debug id comes from the map, the `//# debugId=` comment, or the id a React Native bundle holds, Hermes bytecode included.
  - `--release` also indexes the maps by `service.version` + URL path. A map without a debug id needs it: its id is then derived from the map's bytes.
  - Uploads are write-once: the same map again succeeds (200), a different map under a stored debug id fails (409).
  - `--url-prefix /static/` handles a directory served under a path.
  - `--bundle <file> --sourcemap <map>` (repeatable) uploads a bundle whose map is in another folder, as the Android Gradle plugin and Xcode write them.
  - `--delete-after` removes the `.map` files so they are never deployed.
- `compose <packager.map> <hermes.map> -o <out.map>` composes Metro's map with hermesc's into the map of the bytecode, with the app's `metro-source-map`, and keeps the debug id.

React Native: the debug id has to go in while Metro writes the bundle, before Hermes compiles it. Add `withOuoDebugIds` (bare) or `ouoExpoDebugIdPlugin` (Expo) from `@ouo11y/sourcemaps/metro` to `metro.config.js`, and wrap hot-updater's build plugin with `withOuoSourcemaps` from `@ouo11y/sourcemaps/hot-updater` to upload every OTA bundle's map. Setup, Android and iOS release builds, and OTA tools: [docs/sourcemaps.md, React Native](../../docs/sourcemaps.md#react-native-hermes).
- `upload-dsym <path>...` splits the DWARF file of every `.dSYM` bundle under each path (or the path itself, when it is a file) into its architectures and PUTs each to `<url>/api/v1/projects/<project>/debug-files/dsym/<LC_UUID>` with the same token, so native iOS crashes get functions, files and lines ([docs/symbolication.md](../../docs/symbolication.md)):

  ```bash
  npx ouo-sourcemaps upload-dsym build/MyApp.xcarchive/dSYMs --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" --project my-app
  ```
- Environment variables: `OUO_SOURCEMAPS_URL`, `OUO_UPLOAD_TOKEN`, `OUO_PROJECT_ID`, `OUO_RELEASE`.

Bundler setups (Vite, webpack, Next.js) are in [docs/sourcemaps.md](../../docs/sourcemaps.md).
