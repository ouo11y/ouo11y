# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue, pull request or discussion.

- Email: **security@ouo11y.com**
- Or GitHub > Security > "Report a vulnerability" (private vulnerability reporting).

Include the affected component and version (see the table below), how to reproduce it, and
the impact you expect. We acknowledge within 3 working days and agree a disclosure date with
you; the default embargo is 90 days or the release of a fix, whichever comes first. We credit
reporters in the release notes unless asked not to.

## Supported versions

ouo is pre-1.0. Only the newest minor line of each component receives security fixes; fixes
ship as a patch release of that line.

| Component | Published as | Supported |
|---|---|---|
| Browser SDK | `@ouo11y/browser` | newest 0.x minor |
| React Native SDK | `@ouo11y/react-native` | newest 0.x minor |
| iOS SDK | `ouo11y/ouo11y-ios` (SwiftPM) | newest 0.x minor |
| Grafana app plugin | `ouo11y-rum-app` | newest 0.x minor |
| Collector image | `ghcr.io/ouo11y/collector` | newest 0.x minor |
| rum-api image | `ghcr.io/ouo11y/rum-api` | newest 0.x minor |
| Grafana image | `ghcr.io/ouo11y/grafana` | newest 0.x minor |
| Helm chart | `oci://ghcr.io/ouo11y/charts/ouo` | newest 0.x minor |

Which versions work together: [`docs/compatibility.md`](../docs/compatibility.md).

## What we do on our side

- Dependencies are updated weekly by Renovate; security advisories are proposed immediately.
- CI runs `govulncheck` on every Go module, `npm audit` on the runtime dependencies of the SDKs
  and the plugin, and Trivy on every container image; fixable critical findings fail the build.
- Every release carries an SBOM: images as BuildKit SBOM attestations, npm packages and the
  plugin zip as CycloneDX files attached to the GitHub release. Build provenance is attested
  for images, npm packages, the plugin and the chart (the repository is public since 2026-11-15).
- GitHub Actions are pinned by commit digest; Renovate pins container base images by digest.

The release and supply-chain process is described in
[`docs/releasing.md`](../docs/releasing.md).
