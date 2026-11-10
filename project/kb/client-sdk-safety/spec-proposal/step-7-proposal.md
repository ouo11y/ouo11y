# How the golden rule enters the SDK spec (proposal for Step 7)

This is a proposal. It does not edit [the spec](../../opentelemetry/rum-semantic-conventions/sdk-spec.md); Step 7 decides.

## What the spec has today

Section 12, *Error handling*, already holds the core: ERR-1 (no crash, hang or throw), ERR-2 (patched functions keep behaviour), ERR-3 (chain handlers), ERR-4 (no sync I/O on the UI thread), ERR-5 (no re-entry), ERR-6 (self-disable after 20 errors), ERR-7 (count drops), ERR-8 (debug-only diagnostics), ERR-9 (bounded buffers). Section 13 has budgets, all TBD.

What it lacks, per the [checklist](../checklist/golden-rule-checklist.md): app-set propagation headers (GR-HDR-1), the origin allow-list (GR-HDR-2), co-existing patchers and globals (GR-HDR-4, -5), secrets in logs (GR-PRIV-1), config clamping and no-throw init (GR-CFG-1..5), a remote kill switch with strict validation (GR-KILL-2, -3), storage fallback and namespacing (GR-STO-2, -3), background/battery (GR-BAT-1), persisted-format versions (GR-UPG-1), and the fault-injection harness that makes it testable (GR-CRASH-7). ERR-1 also conflicts with today's web and RN behaviour of throwing on a missing token; the checklist sides with ERR-1.

## Proposed changes

1. **Promote the rule to section 0.** Add one sentence after the RFC 2119 paragraph, before anything else:

   > **The golden rule.** The host app MUST NOT pay for the SDK's failures. When this spec and any other requirement conflict, this rule wins: the SDK drops telemetry, disables a feature, or disables itself before it costs the app a crash, a hang, a slowdown, a changed request, a lost handler or a leaked secret.

2. **Rename section 12 to *Host safety (the golden rule)*** and make the checklist its normative content. Keep ERR-1..9 ids as they are (other sections cite them) and add the checklist items as `SAFE-*` ids, one per GR item, grouped by the 15 categories. Map: ERR-1 ↔ GR-CRASH-1/2, ERR-2 ↔ GR-HDR-3, ERR-3 ↔ GR-HAND-1/3, ERR-4 ↔ GR-MAIN-1, ERR-5 ↔ GR-NET-5, ERR-6 ↔ GR-KILL-1, ERR-9 ↔ GR-MEM-1. The checklist file moves to `docs/specs/` with the spec and stays the single list, so the spec and the checklist cannot drift.

3. **Fix the init contradiction.** Section 3 says configuration errors throw on web and RN. Change to: invalid config never throws; the SDK clamps or falls back (GR-CFG-1) and missing credentials make it a no-op (GR-CFG-2), reported once in debug and through `Ouo.status()` (or the platform equivalent).

4. **Add the remote kill switch to section 8.2.** A collector response field that disables the SDK or a named feature for the rest of the session and the next start, strictly typed, fail-closed (GR-KILL-2, -3). Proposal: an OTLP partial-success style message, so it rides the existing response and needs no extra request at startup (GR-START-3). Founder decision: who can flip it (project admin vs ouo operator).

5. **Add header rules to section 7.2.** Never overwrite an app-set `traceparent`/`tracestate`/`baggage`; propagate only to allowed origins, default same origin (GR-HDR-1, -2).

6. **Add GR-PRIV-1 to section 10.** No part of any credential in any log, at any level.

7. **Section 14 Conformance:** add a required *fault suite* per SDK (GR-CRASH-7) that runs every checklist test, and a *co-existence matrix* with Sentry, Crashlytics and Datadog in both init orders (GR-HAND-4). A release is blocked when any GR item fails.

8. **Section 13 budgets:** fill the main-thread and init rows first, since GR-MAIN-2 and GR-START-1 point at them.

## Order for Step 7's fixes

Fix what hurts users first, all small:

1. Android: clamp `jpegQuality` in `OuoReplayConfig` and wrap the compose body (OUO-1); clamp on the RN side too.
2. Web and RN: keep an app-set `traceparent` (OUO-3, OUO-4).
3. RN: remove the token prefix from the debug log (OUO-2).
4. RN: chain the Hermes rejection tracker where possible, else forward to the previously registered one by default (OUO-5).
5. All: no-throw init (GR-CFG-2), then self-disable (GR-KILL-1), then the fault-injection harness for every SDK, then the remote kill switch.
