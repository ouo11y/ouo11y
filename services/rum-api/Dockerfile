# syntax=docker/dockerfile:1
# The build stage runs on the build platform and cross-compiles for the target, so
# multi-arch builds (release-images.yml) do not compile under QEMU. VERSION is stamped
# into the binary (`rum-api -version`, start-up log); release-images.yml passes it.
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
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/rum-api .
# An empty /data owned by nonroot: Docker copies it into a new named volume mounted there,
# so rum-api can write replays without a chown step (deploy/envs uses a named volume).
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/rum-api /rum-api
COPY --from=build --chown=nonroot:nonroot /out/data /data
# No ENV defaults: environment variables override -config.file, so baking
# RUM_API_ADDR / DATA_DIR here would silently win over a mounted config file.
# The built-in defaults are already :8080 and /data.
EXPOSE 8080
USER nonroot:nonroot
# The image has no shell or curl; the binary probes itself (pass the same
# -config.file flags to -check when the file changes the listen address).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/rum-api", "-check"]
ENTRYPOINT ["/rum-api"]
