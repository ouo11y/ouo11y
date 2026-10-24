# syntax=docker/dockerfile:1
# Grafana with the ouo11y RUM app plugin built from this repository (the device id and the Device
# filter are not in a released image yet). Build context: the repository root (60-grafana/compose.yaml
# sets it).
# Same result as deploy/images/grafana/Dockerfile, plus the plugin build.
FROM node:24-bookworm-slim AS plugin
WORKDIR /src
# The plugin is an npm workspace of the repository: install from the root lockfile, plugin only.
COPY package.json package-lock.json ./
COPY sdk/browser/package.json sdk/browser/
COPY sdk/react-native/package.json sdk/react-native/
COPY examples/ouo-web/package.json examples/ouo-web/
COPY plugins/ouo11y-rum-app/package.json plugins/ouo11y-rum-app/
RUN npm ci --no-audit --no-fund --ignore-scripts -w plugins/ouo11y-rum-app
COPY plugins/ouo11y-rum-app plugins/ouo11y-rum-app
RUN npm run build -w plugins/ouo11y-rum-app

FROM grafana/grafana:13.2.1
COPY --from=plugin --chown=grafana:root /src/plugins/ouo11y-rum-app/dist /var/lib/grafana/plugins/ouo11y-rum-app
ENV GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app \
    GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo11y-rum-app
