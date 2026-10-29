# 2026-10-29 W2: mobile SDK spec and conformance suite

Session started from the W1/W2 orchestration session; branch `claude/w2-mobile-spec` from `origin/main` (61cf4af). Lane C only: nothing in `sdk/ios`, `sdk/react-native/ios` or `sdk/react-native/src` was touched (W1 runs there in parallel).

## What was done

- **`docs/specs/mobile-sdk.md`**: rules for every record; the twelve capabilities C1–C12 with records, required attributes, event names and thresholds, linking session-lifecycle, mobile-vitals, mobile-replay and funnels instead of repeating them; 18 conformance checks (C1.1 … C11.2) with what the golden app does and the pass condition; maturity L0–L3; the matrix for React Native iOS (measured), native iOS, React Native Android, native Android and Flutter (from reading the code); how the suite works and how a package turns a pending check required.
- **ADR-0015** (indexed in `docs/adr/README.md`): one spec, L0–L3, one suite per package with the same check ids, Objective-C and Java as API surfaces, the React Native iOS suite in Node under a native model, strict pending checks, C12 = B3.
- **`tests/e2e/mobile/`**: `conformance.mjs` (runs the golden app, asserts rum-api, prints checks and the maturity row, `--out` JSON), `launch.cjs` (one launch of the built `@ouo11y/react-native` bundle per journey step), `standin.cjs` (model of the `OuoReplay` Expo module and of the OS, plus a fetch wrapper that logs and can refuse collector requests).
- **`tests/e2e/lib.mjs`**: configuration and helpers moved out of `scenario.mjs` (env URLs and credentials, `getJSON`, `pollUntil`, `table`, …) so the two scripts share one copy; `scenario.mjs` imports them, behaviour unchanged.
- **CI**: step `mobile SDK conformance (React Native iOS)` in the `examples` job's ouo-mobile leg (stack, demo backend and SDK build are already there); the `ex-ouo-mobile` path filter now also matches `tests/e2e/mobile/`, `tests/e2e/lib.mjs` and the spec.
- kb [mobile-conformance.md](../../../kb/mobile-conformance.md); agent folder `project/agents/mobile-sdk/`; rows in the agents, kb, docs and ADR indexes; README layout row; checklist N17 note.

## Departures from the roadmap's wording (for the founder at the next checkpoint)

1. **Taps stay `ui.tap`**, not `app.screen.click`: the bridge already emits `ui.tap` (sentry-bridge spec 9a) and the RN SDK too; semconv's `app.screen.click` is a click at coordinates. W5 adds `app.screen.name`, `ouo.ui.gesture`, `ouo.ui.view_type`.
2. **Hangs are `exception` with `ouo.exception.kind = hang`**, not an `app.hang` event: mobile-vitals.md already decided "native hangs are errors", and the bridge maps Sentry's `AppHang` to an exception.
3. **The golden session is produced by the real SDK code in Node**, not a synthetic OTLP session and not a simulator recording (ADR-0015 options). A synthetic session would pass whatever the SDK does.
4. **C4.2 TTFD and C8.3 crash finalisation are pending too**: the brief listed C3, C6, C10, C11 and the first-second crash; TTFD (no API in the RN SDK yet, W4) and a replay finished after a crash (W1) also fail today.

## Verified, and how

- `node tests/e2e/mobile/conformance.mjs` against env `w2-mobile-spec` (ouo-env, built from this branch), backend `http://localhost:20193`: **CONFORMANCE OK, 9 required checks pass, 9 pending**, twice. Row: L2 on C1, C5, C7, C9; L1 on C2, C4, C6, C8, C11; L0 on C3, C10; C12 not e2e.
- Each pending check fails for the expected reason (from `--out` JSON): C2.3 the crashed session has only `exception` and `session.end` (N52 reproduced); C3.2 `terminated` + `healthy`; C6.1 taps without `app.screen.name`; C11.1 the offline run's session has only the next launch's `session.end`; C11.2 OTLP `identity`; C3.1, C4.2, C8.3, C10.1 no record.
- `node tests/e2e/scenario.mjs` against the same env after the `lib.mjs` extraction: E2E OK, 40 sessions.
- `lychee --offline` clean; `ci.yml` parses.

## Findings for other packages

- **W1**: the first frame after a long background lands in the old session's last chunk (native resumes before JS rotates); see the kb entry. Not asserted by any check.
- **W4 / bridge**: the bridge sets `ouo.sentry.mechanism = AppHang` on hang exceptions but no `ouo.exception.kind = hang`; to share C3.1's record the bridge should set it too (a one-line follow-up in `ouosentryreceiver`).
- The RN SDK sends no `device.id` (session-lifecycle allows it to be absent) and no `ouo.navigation.kind` on navigations (the bridge sends `screen`); both are noted in the spec for W5.

## What is left

- Merge after the ADR-0013 review. Each later package removes `pending` from its checks, updates the stand-in when it changes the native module, and updates the spec's matrix (see [tracker.md](../tracker.md)).
- Env `w2-mobile-spec` is up for the review (`http://grafana.w2-mobile-spec.ouo.localhost`); taken down after the merge.
