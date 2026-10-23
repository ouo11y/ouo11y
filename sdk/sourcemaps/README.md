# @ouo11y/sourcemaps

`ouo-sourcemaps` makes errors from minified production bundles readable in ouo. It adds a debug id to every built bundle and uploads the source maps to rum-api, which symbolicates exception stacks when they are read ([ADR-0011](../../docs/adr/0011-source-maps-and-symbolication.md)).

```bash
npm install --save-dev @ouo11y/sourcemaps

# after the build, before deploying
npx ouo-sourcemaps inject dist
npx ouo-sourcemaps upload dist --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" \
  --release "$APP_VERSION" --delete-after
```

- `inject <dir>...` appends `//# debugId=<uuid>` to each `.js` / `.mjs` / `.cjs` file that has a map, together with a one-line snippet that tells `@ouo11y/browser` the id at runtime. It writes the same id into the map. It is idempotent, and no existing mapping moves.
- `upload <dir>...` PUTs each map, gzip-compressed, to `<url>/v1/sourcemaps` with the project's **upload token**. That token is a CI secret, set in rum-api as `projects.<id>.upload_token` or `OUO_UPLOAD_TOKENS`. It is not the public project token the SDK ships with.
  - `--release` also indexes the maps by `service.version` + URL path, for bundles without a debug id.
  - `--url-prefix /static/` handles a directory served under a path.
  - `--delete-after` removes the `.map` files so they are never deployed.
- Environment variables: `OUO_SOURCEMAPS_URL`, `OUO_UPLOAD_TOKEN`, `OUO_PROJECT_ID`, `OUO_RELEASE`.

Bundler setups (Vite, webpack, Next.js) are in [docs/sourcemaps.md](../../docs/sourcemaps.md).
