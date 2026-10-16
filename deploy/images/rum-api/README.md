# rum-api image

There is no separate Dockerfile here on purpose: the rum-api image **is**
[`services/rum-api/Dockerfile`](../../../services/rum-api/Dockerfile) (multi-stage Go build,
distroless `nonroot` runtime, `/rum-api -check` healthcheck). Build it from the repository root:

```bash
docker build -t ouo/rum-api:dev services/rum-api
```

The Helm chart (`deploy/helm/ouo`) references it as `rumApi.image.repository` /
`rumApi.image.tag`. Keep the Dockerfile with the service so the rum-api agent owns the build;
this folder only documents where it lives so `deploy/images/` lists every image the chart runs.
