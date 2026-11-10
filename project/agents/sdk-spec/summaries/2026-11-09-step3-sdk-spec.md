# Step 3: SDK spec draft (2026-11-09)

## What was done

Wrote [sdk-spec.md](../../../kb/opentelemetry/rum-semantic-conventions/sdk-spec.md), version `0.1.0-draft`: one normative spec for web, iOS, Android and React Native. It has about 200 numbered requirements, a test method for every MUST, a register of 21 predictions with confidence and fallback, and placeholders for Step 5's budgets. It answers all twelve Step 2 questions except first display, which goes to Step 4. Docs only. No product code changed.

## Sources

Steps 1 and 2 in `project/kb/opentelemetry/`. Re-read from primary sources on 2026-11-09: event YAML in core v1.45.0 and client-side `main`, the client-side manifest (for the `schema_url`), the `url.full` redaction text, and the diffs of browser PRs #429 and #504. `project/kb-archive/`, `docs/adr-archive/`, `docs/specs/mobile-sdk.md` and the SDK code were not used.

## What the next agent must know

1. **D1 to D5 are still open.** PR #172 has no comments or reviews. The spec applies each recommendation, marks it `[OPEN Dn]`, and section 17 says what changes under the other answer.
2. **Where this differs from Step 2.**
   - Step 2 said no separate replay id and a per-session sequence. The Step 3 brief's hierarchy needs a replay level, so the spec has `ouo.replay.id`, with `ouo.replay.sequence` per stream.
   - The brief's `replay.ended` is written `ouo.replay.ended`, under the naming rule.
3. **Choices made here that Step 7 should challenge.**
   - A session starts only on user activity. Records with no session are dropped, apart from the bypass set (SES-10).
   - A crash always ends the session (SES-13).
   - An unsampled session sends only marked bypass records, excluded from rates so health is not biased (SMP-3, SMP-6).
   - Replay runs only in sampled sessions (SMP-9).
   - All query values are redacted by default, stricter than OTel (PRV-10).
   - One replay chunk per request, so a partial-success count identifies the chunk (TRN-5).
   - Numeric defaults are starting points. The frustration windows for error clicks, the bypass cap and the chunk limits are judgement.
4. **`complete` is a client-side claim** (RPL-21). The store computes final completeness. At page unload a response cannot be observed, so chunks stay persisted until a later page resends them (TRN-19).
5. **One dependency outside the SDK.** "Durably accepted" holds for replay only if the Collector answers 2xx after fsync. Not verified. Step 8 owns it.
6. **Small inconsistency in Step 2:** `performance.md` says "three grouping attributes" for INP but names two without a duration. The spec's P3 says "grouping names".

## What was verified and how

| Check | Method | Result |
|---|---|---|
| Every requirement containing MUST, and every signal id, has a row in the conformance table | Script over the Markdown, expanding ranges | None missing, no dangling reference |
| Each MUST outside a numbered requirement is in a table covered by RES-0, TRN-20, RPL-13, RPL-26 or RPL-27 | Script listing, read by hand | Covered |
| All 26 signals in the Step 2 table appear in the spec | Script | None missing |
| Every `[Pn]` is registered, and the reverse | Script | Matches |
| Links | `lychee --offline` | Clean |

**Not verified:** no SDK, Collector or backend was run, so no requirement has been exercised. The conformance rows are test designs, and none exist as code. Web Locks, IndexedDB, keepalive and bfcache behaviour are from platform knowledge. PRs and issues move daily: the watch list in the Step 2 questions was only checked for #34, #35, #48, #51, #429 and #504 (all still open).

## What is left

Founder decisions, then Step 4. Open decisions and Step 4 questions are in sections 17 and 18 of the spec.

## Dependencies added

None.

## Notes on this run

The brief asked for a new worktree, so this one is nested in the session's own worktree at `.claude/worktrees/step3-sdk-spec`, branch `claude/step3-sdk-spec`, cut from PR #172's head. Upstream tracking was removed so a push cannot land on the Step 2 branch. Not pushed.
