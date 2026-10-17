# 2026-10-13 Sentry SDK bridge design

## Asked

The founder's iOS and Android apps run the Sentry SDKs. Can ouo consume what those SDKs produce, so ouo runs in parallel with Sentry and the apps only change their DSN? The founder's plan is a custom OTel receiver as the SDK target that exports to both Sentry and ouo.

## Done

- `docs/adr/0008-sentry-sdk-bridge.md` (proposed). It adds an `ouosentry` receiver in `ouo-collector` (ADR-0007 rev 2), which:
  - forwards each envelope to Sentry byte for byte and returns Sentry's response verbatim;
  - translates only envelopes that upstream accepted, asynchronously, into ordinary ouo OTLP;
  - resolves the session in the receiver;
  - introduces a `video` replay kind in rum-api.
- `docs/specs/sentry-bridge.md`: the field-level mapping for sessions, errors, transactions and replay, the session resolution rules, the video chunk contract, the rum-api video API, the collector wiring, an attribute allowlist, the expected Sentry vs ouo differences and a verification plan.
- `kb/sentry-envelope-format.md`: protocol facts from develop.sentry.dev and the MIT `sentry-java` sources, with links and open questions.
- Index and tracker updates:
  - the ADR index, which also fixes the stale ADR-0007 title left over from rev 1;
  - `docs/index.md` and `kb/index.md`;
  - the roadmap Phase 12 item and a new conditional trigger;
  - `tracker/roadmap.md`, and the collector and orchestrator trackers.

## Verified, and how

Documents only. Nothing was built or run.

- The protocol facts were read from the sources linked in the kb entry.
- rum-api's fold keeps the last `session.end` (`services/rum-api/internal/session/fold.go`). That is why duplicate ends from a restarted receiver are harmless.
- Not verified: the iOS replay item layout, `replay_id` on events and transactions, the `did` / `user.id` equality, and the touch coordinate space. Each is marked **(verify)** in the spec.

## Branch

`claude/sentry-bridge-design`, created from `phase-8a-install-secure` (local head f89b121, ahead of origin by the ADR-0007 rev 2 commits). It is not stacked on main because the design builds on rev 2.

## Next agent must know

1. Start with the capture in spec section 14 step 1. Session correlation for transactions and replays depends on its answers, and the translator should not be written before them.
2. No new dependencies. msgpack is a small hand-written decoder.
3. Do not copy Relay or Sentry server code (FSL). Use the docs and the MIT SDK sources only.
4. The Sentry receiver needs single-replica or affinity deployment until Phase 11 adds a shared store.
5. Whether the bridge goes ahead of Phase 10 is the founder's call (roadmap section 6).
