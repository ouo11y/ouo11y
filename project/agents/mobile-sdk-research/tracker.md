# mobile-sdk-research tracker

| Item | Status | Notes |
|---|---|---|
| Folder and appendix template | done | `project/kb/mobile-sdk-research/index.md` |
| Appendix A sentry-cocoa | done | sub session `sentry-ios`, 9.32.0, wire size measured on 77 real segments |
| Appendix B sentry-java | done | sub session `sentry-android`, 8.62.0+16, startup blog grounded in commits |
| Appendix C sentry RN + Flutter | done | sub session `sentry-rn-flutter`, RN 8.33.0, Flutter 10.2.0 |
| Appendix D posthog iOS + Android | done | sub session `posthog-native`, iOS 3.92.7, Android 3.73.1, transformer |
| Appendix E posthog RN + Flutter | done | sub session `posthog-rn-flutter`, RN 4.84.3, Flutter 5.58.0 |
| Appendix F Luciq | done | sub session `luciq`, docs + wrappers + binary headers |
| Appendix G open landscape + OTel | done | sub session `landscape-oss`, 30 repos; PostHog row corrected by the orchestrator |
| Appendix H closed landscape | done | sub session `landscape-closed`, 24-vendor feature matrix |
| Comparison, HTML report, indexes, summary | done | orchestrator; spot checks recorded in the summary |
| Roadmap recommendation (order, done, lanes, spec and maturity ladder, Datadog vs Sentry, gaps after W10) | done | `project/kb/mobile-sdk-research/roadmap.md`, `reports/mobile-sdk-roadmap.html`, answers the founder's questions on §12 |
| ADR-0014 replay representation (tiles in `frames` schema 2, not rrweb, not H.264) | todo | proposed in `roadmap.md` §9 together with ADR-0011 rev (native symbolication), ADR-0015 (spec and ladder), ADR-0016 (OTel in process), ADR-0006 rev |
| ADR-0013 automated review, merge and release | proposed | workflows, AGENTS.md rules, releasing doc; founder adds secrets and runs `repo-settings.sh` |
