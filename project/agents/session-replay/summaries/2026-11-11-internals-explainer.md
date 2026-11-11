# 2026-11-11: session replay internals explainer

## Done

- `project/kb/session-replay/session-replay-explainer.html`: seven topics, written and reviewed with the founder one at a time. Platform foundations; capture families; when to capture; browser techniques (rrweb, Sentry, PostHog, Datadog, OpenReplay, Highlight, Clarity); mobile and Flutter techniques and the masking race; shipping each technique as `ouo.replay.chunk`; replay as six steps and what to borrow. Step-through flows link to source at pinned tags with line ranges.
- kb entries in topic folders (`foundations/`, `browser/`, `mobile/`, `shipping/`, `borrowing/`), each with an index; the three source-reading notes brought into the repo (`browser/browser-source-notes.md`, `mobile/native-source-notes.md`, `mobile/cross-platform-source-notes.md`).
- `docs/adr/0018-borrow-the-replay-recorder.md`, **proposed**: copy the recorder core from open source, ouo keeps ship and play, Sentry video first.
- Licences read from each repository's LICENSE file: Sentry SDKs, PostHog SDKs and rrweb MIT; Datadog SDKs Apache-2.0.
- Step 6 links now point at `project/kb/vendor-internals/` on `main` (PR ouo11y/ouo11y#175 merged during this run).

## Verified, and how

- The report opened in the built-in browser: every topic, its animations and toggles, at desktop and 375 px width, light and dark; no console errors; no element wider than the viewport at 375 px (checked with a script over every element).
- Source links: spot checks of line ranges against the pinned tags during the run, plus an automated check over the report and every entry in `project/kb/session-replay/`: 673 GitHub URLs (337 files at their tags, fetched raw, each line range within the file; 33 directory and repo links returned 200). Three ranges ran one to three lines past the end of their file and were clamped.
- `lychee --offline` clean.

## Left

- Founder decision on ADR-0018.
- Side sessions: iOS port spike (branch `sentry-recorder-ios`), masking experiment (branch `masking-experiment`), replay-school site.
- Claims marked as reasoning in topic 7 (why 1 fps replays look acceptable) and the PostHog player fit are not verified.

## For the next agent

- No dependency added. No env started.
- Long words in the step boxes break mid-word at phone width (`overflow-wrap:anywhere`); accepted as minor.
