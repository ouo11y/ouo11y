# `@grafana/create-plugin` for an app with a Go backend

> How do I scaffold a Grafana app plugin with a backend without the interactive prompts, and what bites when it becomes an ouo client plugin?

Verified 2026-11-15 with `@grafana/create-plugin` 9.0.3, `grafana-plugin-sdk-go` v0.299.0 and `grafana/grafana:13.2.5`, building [examples/quickstarts/from-scratch/03-plugin.md](../../../../examples/quickstarts/from-scratch/03-plugin.md).

| Point | What holds |
|---|---|
| No prompts | Every prompt is skipped when its answer is an argument with the prompt's name: `npx @grafana/create-plugin@9.0.3 --pluginType=app --hasBackend --pluginName=sessions --orgName=myorg` (`dist/commands/generate/prompt-user.js` checks `argv.hasOwnProperty(prompt.name)`). `--help` does not list them and starts the wizard |
| What it writes | `<org>-<name>-app/` with plugin id `<org>-<name>-app`, executable `gpx_<name>`, Go module `github.com/<org>/<name>`, four example pages and a config page with tests, Playwright tests, its own Grafana (`docker-compose.yaml`, `.config/docker-compose-base.yaml`, `provisioning/`), GitHub workflows, and coding-agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/skills`, `.codex/skills`). Keep agent files out of this repository: Claude Code would load a nested `.claude/skills` |
| `go test ./...` | Fails or wanders: npm package `flatted` ships Go files under `node_modules/flatted/golang`. Use `go test ./pkg/...` and `go vet ./pkg/...` |
| The user in a resource test | `backend.WithUser(ctx, u)` on the context passed to `CallResource` is ignored: `httpadapter` builds the request context from `req.PluginContext`, so `backend.UserFromContext` returns nil there. Put the user in `CallResourceRequest.PluginContext.User`, as Grafana does |
| Building without Mage | The scaffold says `mage -v build:linuxARM64`. Plain `CGO_ENABLED=0 GOOS=linux GOARCH=<arch> go build -o dist/gpx_<name>_linux_<arch> ./pkg` gives Grafana in Docker the same binary; build `arm64` and `amd64` so one `dist/` works on Apple silicon and Intel. `npm run build` (webpack) empties `dist/` but keeps the `gpx_*` files, so the order does not matter |
| Settings without the config page | Delete `src/components/AppConfig` and drop `addConfigPage` from `module.tsx`; provision `jsonData` and `secureJsonData` in `provisioning/plugins/<id>.yaml` of the Grafana that loads it (`$ENV_VAR` works in `secureJsonData`) |
| Loading it unsigned | `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=<id>` and a bind mount of `dist/` to `/var/lib/grafana/plugins/<id>`; Grafana logs `Plugin is unsigned` (warn) then `Plugin registered`. The app's page lands under **More apps** |
| `@ouo11y/kit` CSS | The scaffold's webpack config already has `style-loader` and `css-loader` for `.css`, so `rrweb-player/dist/style.css` needs nothing |
