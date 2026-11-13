# Building Muninn and its Collector config: library and tool quirks

> Things that cost time on 2026-11-13 and will again.

## ocb: `file_storage` is its own module

`builder.yaml` must name `github.com/open-telemetry/opentelemetry-collector-contrib/extension/storage/filestorage v0.160.0` as the `gomod`. Writing `extension/storage v0.160.0` with `import: .../filestorage` makes ocb resolve the import to the newest `filestorage` (v0.165.1 at the time), which pulls `go.opentelemetry.io/collector/pdata v1.71.0` and fails the build with `undefined: internal.ProtoPoolAnyValue_StringValue` in `pdata/pprofile@v0.160.0`.

## minio-go: create-only writes

`minio.PutObjectOptions.SetMatchETagExcept("*")` (minio-go v7.4.1) sends `If-None-Match: *`. MinIO (pgsty/minio RELEASE.2026-08-04) answers `412 Precondition Failed` when the key exists; `minio.ToErrorResponse(err).StatusCode == 412` is the check. Eight goroutines writing one key at once: exactly one success and seven 412s (`services/muninn/internal/store/store_test.go`, `TestCreateRace`, run against the env's MinIO). Object tags go in `UserTags` on the same PUT, and the bucket policy needs `s3:PutObjectTagging` for them.

## Filesystem store: create-only and durable

Write a temp file in the target directory, `fsync` it, `link(2)` it to the final name (fails with `EEXIST` if the name exists), remove the temp name, `fsync` the directory. `rename(2)` would overwrite and cannot be create-only.

## OTLP from the SDK

`@ouo11y/browser` 0.4.0 sends replay attributes as OTLP `intValue` for integers, `boolValue` for flags, 32-hex ids and the body as `bytesValue`. Muninn also accepts an integral `doubleValue` for an integer attribute, for SDKs whose JSON-minded encoders send numbers as doubles; the spec says `int`.

## Testing without a protobuf dependency

`tests/e2e/muninn/otlp.mjs` hand-encodes `ExportLogsServiceRequest` (about 60 lines of varint and length-delimited fields) and decodes the partial-success response. Enough to send the same bytes an SDK sends, from Node with no package.
