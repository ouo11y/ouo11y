# 2026-11-09 bump klauspost/compress for GO-2026-6865

`govulncheck` started failing on every PR with GO-2026-6865 (panic on two-block frames) reachable in three collector modules. The advisory is new; the code did not change.

## What was done

- Bumped `github.com/klauspost/compress` from v1.19.2 to v1.20.2 in `ouoreplayexporter`, `ouoreplayreceiver` and `ouosentryreceiver`. It is an indirect dependency, so there is no new dependency.

## Verified and how

- `go vet ./...` and `go test ./...` pass in all three modules.
- Local `govulncheck` v1.9.0 no longer lists GO-2026-6865 in those modules. The local Go toolchain is older than CI's, so its standard-library findings are noise; CI is the authority.

## What is left

- `services/rum-api` is still on v1.19.2 as an indirect dependency. CI did not report it as reachable, so it is unchanged.
