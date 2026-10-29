# syntax=docker/dockerfile:1
# Grafana with the ouo11y RUM app plugin baked in (Kubernetes / Helm path).
# The Docker Compose stack bind-mounts plugins/ouo11y-rum-app/dist instead; this image
# exists because a cluster cannot bind-mount a checkout.
#
# Build from the repository root, after `npm run -w plugins/ouo11y-rum-app build`:
#   docker build -t ouo/grafana:dev -f deploy/images/grafana/Dockerfile .
# The build context is the whole repo; Dockerfile.dockerignore (next to this file,
# honoured by BuildKit) keeps everything but the plugin dist out of the context.
FROM grafana/grafana:13.2.5

# plugin.json id is ouo11y-rum-app; Grafana scans $GF_PATHS_PLUGINS (/var/lib/grafana/plugins).
COPY --chown=grafana:root plugins/ouo11y-rum-app/dist /var/lib/grafana/plugins/ouo11y-rum-app

# The plugin is unsigned (private distribution, see plugins/ouo11y-rum-app/README.md).
ENV GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app \
    GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo11y-rum-app
