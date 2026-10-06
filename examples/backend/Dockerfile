# syntax=docker/dockerfile:1
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/demo-backend .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/demo-backend /demo-backend
ENV PORT=8081
EXPOSE 8081
USER nonroot:nonroot
# The image has no shell or curl; the binary probes itself.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/demo-backend", "-check"]
ENTRYPOINT ["/demo-backend"]
