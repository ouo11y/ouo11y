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
ENV RUM_API_ADDR=:8080 DATA_DIR=/data
EXPOSE 8080
USER nonroot:nonroot
# The image has no shell or curl; the binary probes itself.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/rum-api", "-check"]
ENTRYPOINT ["/rum-api"]
