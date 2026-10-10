# syntax=docker/dockerfile:1
# Grafana with the ouo RUM app plugin baked in (Kubernetes / Helm path).
# The Docker Compose stack bind-mounts plugins/ouo-rum-app/dist instead; this image
# exists because a cluster cannot bind-mount a checkout.
#
# Build from the repository root, after `npm run -w plugins/ouo-rum-app build`:
#   docker build -t ouo/grafana:dev -f deploy/images/grafana/Dockerfile .
# The build context is the whole repo; Dockerfile.dockerignore (next to this file,
# honoured by BuildKit) keeps everything but the plugin dist out of the context.
FROM grafana/grafana:13.2.1

# plugin.json id is ouo-rum-app; Grafana scans $GF_PATHS_PLUGINS (/var/lib/grafana/plugins).
COPY --chown=grafana:root plugins/ouo-rum-app/dist /var/lib/grafana/plugins/ouo-rum-app

# The plugin is unsigned (private distribution, see plugins/ouo-rum-app/README.md).
ENV GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app \
    GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app
