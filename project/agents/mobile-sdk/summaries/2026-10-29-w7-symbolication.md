# 2026-10-29 W7: native iOS crash symbolication from dSYMs

Branch `claude/w7-symbolication`, cut from `origin/main` (61cf4af) in a separate worktree: the shared `mobile-sdk-research-bf838b` worktree holds another session's uncommitted web-sdk-research work and was left untouched.

## What was done

- **ADR-0011 revised** (section 7, no new number): the build UUID (`LC_UUID`, the `debug_id` of every image in a crash report) is the key, dSYM slices are stored as `<project>/dsym/<uuid>.dwarf.gz` + `.json` in the same `sourcemaps/` root (retention, sweep, list and delete-by-project unchanged), symbolication on read in rum-api, no release index needed. R8 stays with W9, Hermes maps with N41.
- **rum-api** (`internal/sourcemap`): `Store.PutDSYM` splits a universal Mach-O into slices, checks `LC_UUID` and `__debug_info`, stores each slice; `Ref.DSYM` loads one. `debugFile` (Go `debug/macho` + `debug/dwarf`, no new dependency) indexes the compilation units, looks an address up in every unit that covers it, expands inlined chains, falls back to the symbol table. `Symbolicate` takes native `frames` / `images` (from `ouo_crash_frames` / `ouo_crash_images` on read, or in `POST /v1/symbolicate`), applies `svma = addr - image_addr + image_vmaddr` (minus one after frame 0) and rewrites the Apple-style stack atos style. The parsed-object cache is shared with source maps and gained a byte budget (`sourcemaps.cache_bytes`, 512 MiB). `PUT /v1/dsyms` (upload token, gzip, `limits.max_dsym_bytes` 512 MiB); `putSourceMap` and `putDSYM` share `readUpload` / `writeStoreError`.
- **CLI** (`sdk/sourcemaps`): `ouo-sourcemaps upload-dsym <path>...` finds `*.dSYM/Contents/Resources/DWARF/*` under the paths and PUTs each file gzip-compressed; `upload` and `uploadDSYM` share one `put` helper.
- **Plugin** (`StackTrace.tsx`): native frames render as `function (file:line) in binary`, `(inlined)`, or `binary address` without a dSYM; badge says "symbolicated n/m"; the header of the Original view stops at the first frame line, so Binary Images stay in the Raw view only.
- **Docs**: `docs/symbolication.md` (new, indexed), rum-api README (endpoints, settings), `config.example.yaml`, CLI README, kb `dsym-symbolication.md` (new) and a pointer in `ios-native-crashes.md`, checklist section 7 line updated.

## Verified, and how

- `go vet ./...` and `go test ./...` in `services/rum-api`: clean. New tests on a real fixture (`testdata/dsym/crashy.dwarf`, arm64 + x86_64, made by `gen.sh` from `crashy.c`, local paths mapped to `/src`): slices and UUIDs, validation (not Mach-O, no DWARF, size, truncated), frames equal to `atos -i` output including an inlined function, partial status with a system frame, stack rewrite, image lookup by range, symbol fallback, cache byte budget, backend error, sweep and delete; HTTP: upload auth, 400 / 201, `POST /v1/symbolicate` and the session timeline with a native exception.
- `sdk/sourcemaps`: typecheck, 13 Vitest tests (2 new: dSYM discovery and upload, upload error), build.
- Plugin: typecheck, `StackTrace` tests (1 new for native frames), full jest and lint (see the PR).
- **End to end on `ouo-env w7-symbolication`** with `project/agents/mobile-sdk/verify/w7-dsym-e2e.sh`: `OuoCrashProbe` SIGSEGV, dSYM by `dsymutil`, exception attributes from the RN SDK's own `nativeCrashAttributes`, OTLP through the collector, upload with the CLI, `GET /v1/sessions/{id}`: `crashSegv (main.swift:42)`, `level2 (:47)`, `level1 (:56)`, `main (:58)`, the same as `atos -i`, status `partial` 4/5 (dyld's start frame has no dSYM). The Grafana plugin showed the same four frames under "symbolicated 4/5".
- Measured on a real 50 MiB React Native Release dSYM (numbers in the kb entry): 24–31 ms parse, 0.85 ms per address, 200/200 sampled functions named. That run found the overlapping-units problem, which the unit index fixes.

## Review round 1 (2026-10-30, reviewer session, PR comment "Review: changes needed")

The reviewer compared `lookup()` with `atos -i` on 4,246 addresses (C and C++, DWARF 4 and 5, -O1 and -O2): 0 mismatches. Answers:

- Conflicts with `main` (PR #105 created the same agent files): merged `origin/main`, both sides kept.
- Binary names with spaces were not rewritten (Go `nativeLine`, plugin `FRAME_LINE` matched the name with `\S+`): now lazy up to the address, a test on each side with `My Crashy App`.
- The server's 60 s read timeout capped dSYM uploads below `max_dsym_bytes`: `putDSYM` raises its read and write deadlines to 10 minutes through `http.ResponseController`. `TestDSYMUploadOutlivesReadTimeout` sends a slow upload through `otelhttp.NewHandler` (as `main.go` does) with a 200 ms server timeout; it fails without the fix (checked).
- CLI: `uploadOptions()` resolves `--url` / `--token` / `--project` / `--release` once for both commands.
- `mapped` and `status` of a native stack count captured frames, not the rows of inlined functions; the plugin's denominator leaves inlined rows out.
- Cold-load deduplication in the cache: tracker row, not this PR.
- `image (grafana)` (Trivy, CVE in the `grafana/grafana:13.2.1` base) is red on `main` too; fixed in its own PR, this one merges after it.

## Before the merge (2026-10-30)

Merged `origin/main` with #108 (Grafana 13.2.5), W1 #109 and W2 #106: `project/agents/mobile-sdk/{index,tracker}.md` kept both sides' rows, W7 joined W2's tracker table. On the rebuilt `ouo-env w7-symbolication`: `go vet` / `go test ./...`, CLI and plugin tests, `lychee --offline` clean; the W2 conformance suite (`node tests/e2e/mobile/conformance.mjs`) `CONFORMANCE OK`, 11 required checks including C2.2 and C2.3; `w7-dsym-e2e.sh` again 4 frames equal to `atos -i`, partial 4/5.

## Left, and what the next agent must know

- Swift names are DWARF base names (`level2`, not `level2(_:)`); symbol-table names stay mangled. A Swift demangler would be its own package or a dependency: not done.
- Upload goes to rum-api directly; the collector route is N41 (maps and dSYMs together).
- Not run on the `examples/ouo-mobile` Chaos screen in the simulator: the probe exercises the same `OuoCrash` handler and RN attribute code, and the brief allowed either.
- No dependency added.
- Env `w7-symbolication` (`http://grafana.w7-symbolication.ouo.localhost`) is torn down after the merge.
