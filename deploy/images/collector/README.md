# collector image

There is no separate Dockerfile here on purpose: the ouo collector image **is**
[`collector/Dockerfile`](../../../collector/Dockerfile), the custom OpenTelemetry Collector
distribution built with ocb from `collector/builder.yaml` (upstream OTLP receiver,
`basicauth`, `resource`, `transform`, `batch`, `memory_limiter`, the OTLP exporters,
`health_check`, plus ouo's `ouoreplay` receiver and exporter and the `ouoratelimit`
processor; ADR-0007 section 1). Build it from the repository root:

```bash
docker build -t ouo/collector:dev collector
```

The Helm chart (`deploy/helm/ouo`) references it as `collector.image.repository` /
`collector.image.tag` (`ghcr.io/ziadmansourm/ouo/collector` in releases) and runs it with
`--config=/etc/otelcol/config.yaml`; the config is the chart's ConfigMap mirroring
`deploy/compose/collector/config.yaml`, the htpasswd next to it comes from a Secret. The
collector agent owns the build; this folder only documents where it lives so
`deploy/images/` lists every image the chart runs.
