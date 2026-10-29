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

## Review round 1 (PR #106, 2026-10-30)

The reviewer session found that C8.1 passed only because the stand-in captured a frame at the rotation, which the Swift recorder never does. Changes:

- **Stand-in = Swift recorder**: no capture at the rotation; chunks take the session id and seq of their first frame and are cut at 5 s, 10 frames, pause, background, rotation or flush (`ChunkBuilder`); the timer stops on background and resumes with an immediate frame (`ReplayRecorder`); the module is registered on `globalThis.expo.modules` (what the SDK reads first) instead of a `Module._load` hook. The `main` journey stays 1.5 s in the second session so its first timer frame lands, as on a device.
- Verified after the changes: conformance on env `w2-mobile-spec` CONFORMANCE OK, 9 required pass, 9 pending (C8.1 now from the timer frame in the second session, pending reasons unchanged); `scenario.mjs` E2E OK, 40 sessions; lychee clean.
- **CI**: the `ex-ouo-mobile` filter also matches `services/rum-api/` and `collector/` (the suite asserts both); `--out` dropped in CI (failures already print their detail).
- **Code**: `detail()` is `getJSON(...).catch(() => null)`; one `OUO_E2E_TIMEOUT` default (180 s, in `lib.mjs`).
- **Spec**: rule 2 defers to session-lifecycle.md for `session.previous_id`; C8 modes link ADR-0014 instead of restating them; C3 says a foreground kill with no known cause is a fatal `termination` with cause `unknown`, and only the runs the heuristic excludes stay `terminated`; C2.1 names `ouo.exception.fatal`; §5 lists the CI paths. ADR-0015 status names the two departures to confirm.
- Rebased on main after #105 (ADR-0014/0016): the `mobile-sdk` index and tracker hold both packages.
- Left as is: folding `examples/ouo-mobile`'s Node leg into this suite (review item 13). It is worth doing once W1 lands, so there is one Node harness for the RN SDK.

## Rebase after W1 and #108 (2026-10-30)

W1 (#109) merged first and changed the `OuoReplay` module, so the stand-in follows it (ADR-0015 decision 4):
- `CapturePacer` in `session` mode, with an immediate frame on start and resume. `screenDidChange` requests a frame in `navigation` mode. `auto` is `session`, because the modelled device has more than 3.5 GiB.
- `ChunkSpool`: the open chunk is on disk, and `recoverPendingChunk` and `start` send it once per process.
- `installCrashReporter` and `setCrashSessionId` take the session start, and the report carries `session_started_ms`.

**Checks turned required:**
- **C8.3** passes: the crashed launch's open chunk arrives through the spool.
- **C2.3** is rewritten to what N52 fixed. W1 sends no `session.start` for a session lost in its first second; it carries the start on `session.end`, and rum-api folds it in. The check therefore asserts that the session starts when it started (at or before the replay start, not at the crash), is `crashed`, and ends at the crash with reason `crash`. Before W1, `started_at` was the crash time, so the check tells the two apart.

**Verified** on env `w2-mobile-spec`, rebuilt from the rebased branch: CONFORMANCE OK, 11 required pass, 7 pending. Row: L2 on C1, C2, C5, C7, C8, C9; L1 on C4, C6, C11; L0 on C3, C10.

## What is left

- Merge after the ADR-0013 review. Each later package removes `pending` from its checks, updates the stand-in when it changes the native module, and updates the spec's matrix (see [tracker.md](../tracker.md)).
- Env `w2-mobile-spec` is up for the review (`http://grafana.w2-mobile-spec.ouo.localhost`); taken down after the merge.
