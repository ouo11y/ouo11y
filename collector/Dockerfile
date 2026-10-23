# syntax=docker/dockerfile:1
# ouo-collector image: the OpenTelemetry Collector Builder (ocb) compiles builder.yaml
# (upstream components pinned to 0.160.0 plus our own modules) into a static binary.
#
#   docker build -t ouo/collector:dev collector
#
# The build stage runs on the build platform and cross-compiles for the target, so
# multi-arch builds (release-images.yml) do not compile under QEMU.

ARG OCB_VERSION=v0.160.0

FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG OCB_VERSION
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install go.opentelemetry.io/collector/cmd/builder@${OCB_VERSION}
COPY builder.yaml ./
COPY extension ./extension
COPY receiver ./receiver
COPY exporter ./exporter
COPY processor ./processor
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    builder --config builder.yaml \
    && cp dist/ouo-collector /ouo-collector

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /ouo-collector /ouo-collector
EXPOSE 4317 4318 4319 4320 13133
USER nonroot:nonroot
ENTRYPOINT ["/ouo-collector"]
CMD ["--config=/etc/otelcol/config.yaml"]
