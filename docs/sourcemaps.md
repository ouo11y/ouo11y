# Source maps: readable stacks from minified web apps

A production bundle turns `RenderBomb` in `src/components/ChaosPanel.tsx:18` into `at o (https://shop.example/assets/index-B3x9.js:40:1234)`. With source maps uploaded to ouo, the session page and rum-api's API show the original file, line, column and function, and the source line that threw. The raw stack stays available behind a toggle. The design is [ADR-0011](adr/0011-source-maps-and-symbolication.md).

## How it works

1. Your build emits source maps.
2. `ouo-sourcemaps inject` gives every bundle a **debug id** (`//# debugId=<uuid>`) and a one-line snippet that tells `@ouo11y/browser` the id at runtime. The same id goes into the map.
3. `ouo-sourcemaps upload` sends the maps to rum-api with the project's **upload token**. Then you deploy the bundles, without the maps.
4. When an error happens, the SDK adds `ouo.exception.debug_ids` (script URL to debug id) to the exception record. The raw stack goes to Loki unchanged.
5. When the session is read, rum-api finds each frame's map by its debug id, or by `service.version` + the script's URL path when there is none, and returns a `symbolicated` stack next to the raw one.

Maps uploaded after an error still apply: symbolication happens on read.

## Setup

### 1. Give the project an upload token (operator)

The upload token is a **secret**, like a deploy key, kept in your CI. It is not the public `projectToken` that ships in the bundle. Configure one per project in rum-api:

```bash
# environment
OUO_UPLOAD_TOKENS=web-store:ut_9f3c...,shop:ut_71aa...
```

```yaml
# or config.yaml
projects:
  web-store:
    upload_token: "${OUO_UPLOAD_TOKEN_WEB_STORE}"
```

The local stack (`deploy/compose`, `ouo-env`) ships `demo:ut_dev_demo_0000000000000000`.

**Network:** uploads go to rum-api, which is never public (ADR-0007). CI reaches it over your private network: a self-hosted runner, a VPN, or `kubectl port-forward svc/ouo-rum-api 8080` with the Helm chart. If your CI runs on hosted runners and cannot reach rum-api, see [Limits](#limits).

### 2. Install the CLI and the SDK

```bash
npm install @ouo11y/browser
npm install --save-dev @ouo11y/sourcemaps
```

Pass the same version to the SDK (`service.version`) and to `--release`. The release index then serves bundles that have no debug id.

### 3. Build with maps, inject, upload, delete

Add the step after your build and before your deploy:

```bash
npx ouo-sourcemaps inject dist
npx ouo-sourcemaps upload dist \
  --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" \
  --project web-store --release "$APP_VERSION" --delete-after
```

`--delete-after` removes the `.map` files once every upload succeeded, so you never serve your sources. Use `--url-prefix /static/` when the output directory is served under a path, so that `dist/js/a.js` is `/static/js/a.js` in the browser.

## Bundlers

### Vite

```ts
// vite.config.ts
export default defineConfig({
  build: { sourcemap: "hidden" }, // maps on disk, no sourceMappingURL in the bundle
});
```

```json
// package.json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "ouo-sourcemaps inject dist && ouo-sourcemaps upload dist --release $npm_package_version --delete-after"
  }
}
```

`OUO_SOURCEMAPS_URL` and `OUO_UPLOAD_TOKEN` come from the CI environment. `examples/ouo-web` does this in `scripts/run.sh`.

### webpack

```js
// webpack.config.js
module.exports = {
  mode: "production",
  devtool: "hidden-source-map",
  output: { publicPath: "/assets/" },
};
```

```bash
webpack && ouo-sourcemaps inject dist && \
  ouo-sourcemaps upload dist --url-prefix /assets/ --release "$APP_VERSION" --delete-after
```

### Next.js

```js
// next.config.js
module.exports = { productionBrowserSourceMaps: true };
```

The browser bundles are under `.next/static`, served at `/_next/static`:

```bash
next build && ouo-sourcemaps inject .next/static && \
  ouo-sourcemaps upload .next/static --url-prefix /_next/static/ --release "$APP_VERSION" --delete-after
```

Run `inject` before `next start` or before you copy `.next` into your image. The server bundles (`.next/server`) are not browser code and need no upload.

### Rollup / Vite with native debug ids

Rollup's `output.sourcemapDebugIds: true` already writes `//# debugId=`. `ouo-sourcemaps inject` keeps that id and adds only the runtime snippet, so run it anyway.

## What you see

- **Session page** (plugin): an exception with mapped frames shows a `source mapped` badge. Its stack opens on the original frames and source lines, and an **Original / Raw** toggle switches to the stack as recorded. Frames without a map are greyed and keep their minified position.
- **rum-api**: exceptions in `GET /v1/sessions/{id}` and `/logs` carry `symbolicated` (`status` `ok` / `partial` / `no_maps`, frames with `generated` and `original` positions, source context). `POST /v1/symbolicate` maps any stack (see `services/rum-api/README.md`, section Source maps).
- **Loki** keeps `exception.stacktrace` as the browser sent it, plus `ouo.exception.debug_ids`.

## Checking an upload

```bash
curl -s -H "Authorization: Bearer $OUO_READ_TOKEN" "$RUM_API/v1/sourcemaps?project=web-store" | jq '.sourcemaps[0]'
```

If a stack still shows minified frames:

- **No `ouo_exception_debug_ids` on the record.** The deployed bundle was not injected (inject runs after every build), or the error came from a script you did not upload, such as a third-party CDN script.
- **`no_map` with a debug id.** Nothing was uploaded under that id for this project. Check the token's project and the upload output.
- **`no_map` without a debug id.** The release fallback needs the same `--release` as the SDK's `service.version`, and the same URL path (check `--url-prefix`).
- **Function names.** The function name comes from the original source around the line when the map embeds `sourcesContent`, which is the default in Vite, webpack and esbuild. Otherwise it comes from the caller's call site. That second method is a heuristic and can name a wrapper.

## Retention and deletion

Maps are kept `retention.sourcemaps` (default 90 days) from their upload, per project overridable. A re-upload restarts the clock. Keep it at least your log retention, or older errors lose their maps. rum-api warns at start-up when it is shorter. `DELETE /v1/admin/projects/{project}` deletes the project's maps with its data ([data lifecycle](operations/data-lifecycle.md)).

## Limits

- Uploads go to rum-api directly. A public upload path through `ouo-collector`, for CI on hosted runners, is planned (checklist N41).
- React Native / Hermes maps use the same store and CLI (release + bundle name). Their frame parsing is in place, but the RN SDK does not send debug ids yet (ADR-0011 section 6).
- One map is limited to 64 MiB decompressed (`MAX_SOURCEMAP_BYTES`).
