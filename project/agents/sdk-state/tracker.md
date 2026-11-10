# sdk-state tracker

| Date | Event |
|---|---|
| 2026-11-10 | Step 5: spec compliance audit of all four SDKs (199 requirements each), gap analysis against Sentry on Step 4's Must and Should features, overhead measured on web, iOS simulator and Android emulator against Sentry, budgets proposed for spec section 13. [summary](summaries/2026-11-10-step5-sdk-state.md) |

## Open

- Founder review of the proposed budgets; Step 7 writes them into spec section 13.
- The conformance suite of spec section 14 does not exist; this audit read code and ran unit tests, it did not capture the wire for every rule.
- OVH-1 CI jobs: the harnesses here are the starting point; they are not wired into CI.
- Device numbers: everything mobile is simulator or emulator. One iPhone run would calibrate them (counted against the founder's device budget).
