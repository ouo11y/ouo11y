# rum-api-retirement tracker

- [x] 2026-11-14 Inventory of rum-api's routes; founder decision (upload straight to Muninn); ADR-0026 proposed; kb entry.
- [x] 2026-11-14 Muninn: debug-file routes (public write-only upload, private reads), project delete (MUN-45), audit entries, debug-file retention.
- [x] 2026-11-14 `ouo-go`: `DebugFile` / `DebugFileIDs`, `symbolicate` (JS, Hermes, dSYM), delete and audit client methods, `erase`, `cmd/ouo-erase`.
- [x] 2026-11-14 `ouo-sourcemaps upload` / `upload-dsym` to Muninn; dSYM slicing moved into the CLI.
- [x] 2026-11-14 ouo-web uploads to Muninn when the stack runs it; verify checks debug ids and the stored map.
- [ ] Muninn in the VM install and the Helm chart, with only the upload route published (Caddy, Ingress).
- [ ] Delete `services/rum-api`, its plugin pages, `OUO_UPLOAD_TOKENS` in compose, and the rum-api text in `docs/operations/data-lifecycle.md` and the Helm README.
- [ ] Publish `@ouo11y/sourcemaps` with the new upload path (release-please, `--project` now required: breaking).
- [ ] Optional: a `__debug_info` check in the CLI's `machoSlices` (rum-api refused an app binary uploaded as a dSYM; Muninn stores it opaque).
