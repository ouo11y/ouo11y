# syntax=docker/dockerfile:1
# Same shape as services/rum-api: cross-compiled build stage, distroless runtime, the
# binary probes itself for the health check. VERSION is stamped into the binary.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/muninn .
# An empty /data owned by nonroot, for the filesystem store on a named volume.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/muninn /muninn
COPY --from=build --chown=nonroot:nonroot /out/data /data
EXPOSE 3400
USER nonroot:nonroot
# Pass the same -config.file flags to -check when the file changes the port.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/muninn", "-check"]
ENTRYPOINT ["/muninn"]
