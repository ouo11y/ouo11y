# 2026-11-11: replay-school

Side session of the session-replay agent. Branch `claude/replay-school-d3f20c`, cut from `claude/session-replay-internals` (PR ouo11y/ouo11y#178, not merged when this ran).

## Done

- `project/kb/session-replay/school/`: an animated course in 25 lessons plus a contents page. Order: six fundamentals (pixels versus structure, the event loop and frames, view trees per platform, keyframes and deltas, compression including H.264 P-frames and skip blocks, masking as data versus geometry), six topics (hooks, what to record, the masking race, packing, sending and `ouo.replay.chunk`, playing), twelve technique lessons (five web, five mobile, React Native, Flutter), and a finale on the six-step model and ADR-0018 (proposed). Every lesson ends with a quiz.
- Shared `school.css` (the explainer's colour tokens, light and dark) and `school.js` (lesson list, theme toggle shared with the explainer through the same `sr-theme` key, progress bar, quizzes with shuffled options, the step-through flow component, ← → keys between lessons). No external requests.
- Content reuse: the explainer's demos, flows, tables and text were pulled in verbatim by line range, with relative links re-rooted one level deeper and cross-references such as "topic 5.0" rewritten to lesson links. Every technique step keeps its source link at the pinned tag.
- New material, written for the fundamentals:
  - lesson 1, a "read versus look" demo on one cart screen;
  - lesson 5, a live LZ77 back-reference finder, a base64 encoder, and a frame-diff demo that renders two frames and classifies each tile (ouo, 64 px) and each 16×16 block (H.264: skip, moved, coded);
  - lesson 6, a slider that moves a list between the tree walk and the copy.
  Lesson 5's mechanisms are cited to RFC 1950–1952, RFC 4648 and ITU-T H.264 and marked as not read in code; its vendor numbers link to Sentry source and Step 6.
- `school/index.md`, a row in `project/kb/session-replay/index.md`, tracker row.

## Verified, and how

- `lychee --offline` over the repository's `.md` and `.html`: 0 errors (school alone: 342 links, 0 errors).
- A script resolved every relative path in the school pages, including those inside JavaScript strings that lychee does not see: 271 paths, 0 missing.
- In the built-in browser over a local static server: every page loaded in a 375 px and a 1100 px frame, every button pressed and one answer clicked per quiz. Result: 0 script errors, document width equal to viewport width at both sizes on all 26 pages, every lesson has 3 or 4 questions. The sweep ran twice, the second time after the last changes.
- By eye, at phone width in dark and light and at desktop width in light: contents, fundamentals 3, 5 and 6, topics 1, 3 and 5, Sentry iOS, the web comparison quiz, the finale's borrow map. Fixes made from this: wide SVG timelines (session simulator, keyframe strip, chunk strip and pipeline) now keep a minimum width and scroll inside their card on phones; anchored headings clear the sticky bar; quiz options are shuffled so the right answer has no fixed place.
- Quiz scoring, the "done" tick on the contents page (browser storage, wrapped in try/catch) and theme persistence checked by script.
- Reduced motion: checked by reading the code (a CSS rule disables animations and transitions; every timer-driven demo uses slower steps; auto-playing demos, the hero, the borrow map and lesson 6's slider, do not start). Not emulated in the browser.

## Left

- Claims carried over from the explainer as reasoning or unchecked stay marked: why 1 fps replays look acceptable; whether the rrweb player fits PostHog wireframes.
- No leak rate has been measured for any masking defence; lesson 9 says so. The iOS port spike and the masking experiment may each add a lesson after the topic they inform.
- Rebase onto `main` once PR ouo11y/ouo11y#178 merges.

## For the next agent

- No dependency added. No env started.
- Pages are plain HTML and are edited directly. They were generated once from fragments by a throwaway script that was not committed. The lesson order is `RS.PAGES` in `school.js`. Prev/next links are written in each page.
- The explainer's demo code is duplicated into the lessons; a fix in one does not reach the other.
