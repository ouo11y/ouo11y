# syntax=docker/dockerfile:1
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/rum-api .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/rum-api /rum-api
# No ENV defaults: environment variables override -config.file, so baking
# RUM_API_ADDR / DATA_DIR here would silently win over a mounted config file.
# The built-in defaults are already :8080 and /data.
EXPOSE 8080
USER nonroot:nonroot
# The image has no shell or curl; the binary probes itself (pass the same
# -config.file flags to -check when the file changes the listen address).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/rum-api", "-check"]
ENTRYPOINT ["/rum-api"]
