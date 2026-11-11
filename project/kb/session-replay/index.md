# Session replay internals

How session replay works inside, on the browser, iOS, Android, React Native and Flutter, read from the vendors' source at pinned release tags (2026-11-10/11). Written for the founder as seven topics; the animated explainer holds the walkthroughs and demos, the entries below hold the text and the citations.

Nothing here is a decision. The proposed decision that follows from topic 7 is [ADR-0018](../../../docs/adr/0018-borrow-the-replay-recorder.md) (proposed).

| Entry | Content |
|---|---|
| [session-replay-explainer.html](session-replay-explainer.html) | The animated explainer: topics 1–7 with step-through flows, the masking race, a capture-timing simulator and a chunk builder. Light and dark, phone width, no network |
| [school/](school/index.md) | replay-school: the same material as an animated course in 25 lessons, fundamentals first (including compression and H.264 skip blocks), then topics, then one lesson per vendor and platform; each lesson ends with a quiz. Open `school/index.html` |
| [foundations/](foundations/index.md) | Topics 1–3: what each platform lets a recorder read, the capture families, and when to capture and flush |
| [browser/](browser/index.md) | Topic 4: rrweb, Sentry, PostHog, Datadog, OpenReplay, Highlight and Clarity on the web |
| [mobile/](mobile/index.md) | Topic 5: Sentry, PostHog, Datadog and OpenReplay on iOS and Android, React Native and Flutter, and the masking race |
| [shipping/](shipping/index.md) | Topic 6: how each technique maps onto `ouo.replay.chunk`, today and in the draft spec |
| [borrowing/](borrowing/index.md) | Topic 7: replay as six steps, which to borrow from open source, licences, and the founder's questions answered |

Related: Step 6 vendor research in [vendor-internals/](../vendor-internals/index.md) (bytes, wire formats, fixtures; not repeated here) and Step 5 measurements in [client-sdk-state/overhead.md](../client-sdk-state/overhead.md).
