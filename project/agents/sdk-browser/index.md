# sdk-browser

Owns `sdk/browser` (`@ouo11y/browser`).

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-06-phase-2.md](summaries/2026-10-06-phase-2.md) Phase 2: SDK built, tested, verified against the stack
  - [2026-10-08-bugfix.md](summaries/2026-10-08-bugfix.md) QA phase 6 bug 1: duplicate `session.start` on rotation fixed, regression tests, live re-check
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a: ingest gateway and project tokens (ADR-0007), SDK 0.2.0, demo app and guide updated
  - [2026-10-23-batch3-n10-n25.md](summaries/2026-10-23-batch3-n10-n25.md) Batch 3: vitals at page hide fixed, interaction / soft-navigation spans, long tasks, rage and dead clicks, React subpath, meta traceparent, multi-tab replay, sampling, bundle budget, cross-browser CI
  - [2026-10-24-n36b-safety-long-sessions.md](summaries/2026-10-24-n36b-safety-long-sessions.md) N36 part B (N42, N43): every hook guarded, shutdown / re-init, SSR and `"use client"`, storage fallback, ES2022 floor with es-check, fault and CSP e2e in three engines, 1 h soak, rrweb cost, snapshot-size guard, terser
  - [2026-10-24-session-lifecycle.md](summaries/2026-10-24-session-lifecycle.md) N45: rotation on user change, `endSession`, `clearUser`, `device.id`, rum-api `device_id`
  - [2026-10-24-n36a-delivery.md](summaries/2026-10-24-n36a-delivery.md) N36 part A: delivery layer (retry, gzip, keepalive split, IndexedDB offline store), first-party endpoint docs, network-fault e2e in three engines
  - [2026-11-03-p1-privacy-defaults.md](summaries/2026-11-03-p1-privacy-defaults.md) P1 (client JUHI): `maskAllText` default on with `ouo-unmask`, click names masked, `excludeRoutes`, RN `excludeScreens` / `hideScreen()`, hidden marker in the plugin, ADR-0003 revision
  - [2026-11-12-rebuild-on-the-spec.md](summaries/2026-11-12-rebuild-on-the-spec.md) Rebuilt on the client SDK spec (ADR-0020): spec API and wire, sessions, bypass set, consent, URL sanitising, OTLP replay (`replay.mode: structure/dom`, format `rrweb/2`; the pixel recorder paused), fault injection, 157 of 157 web MUSTs recorded with tests, demo app and live-stack verification
  - [2026-11-13-replay-first-chunk-keyframe.md](summaries/2026-11-13-replay-first-chunk-keyframe.md) Fix: chunk 0 of a replay stream is always the keyframe (rrweb's page-load events before the first snapshot are discarded); unit and real-browser `Replayer` tests
- `scripts/` [build_compliance.py](scripts/build_compliance.py) builds the per-requirement compliance report
- `findings/` [web-compliance.json](findings/web-compliance.json) the data behind that report
- `reports/` HTML reports
  - [long-sessions-2026-10-24.html](reports/long-sessions-2026-10-24.html) 1 h soak (Chromium, WebKit) and rrweb cost on 10k / 50k elements
