# 2026-11-15: client name scrubbed from the tree

Session `public-flip-ci`, branch `claude/scrub-client-name`. Founder 2026-11-15: "Scrub tree, keep history".

- A pilot client's name appeared in 19 files on `main`. Prose now says "a pilot client"; identifiers in tests and docs became neutral: tenant and project id `pilot`, `com.example.app` / `Example.app`, `client-care-api`, `client-eu`. Git history is not rewritten.
- `project/agents/grafana-plugin/reports/phase-4-verification.html` still matches a case-insensitive search: four letters by chance inside base64 image data, not the name. Left as is.
- Verified: `go test` of `services/rum-api/internal/{config,sourcemap,upstream}`, `vitest` of `sdk/react-native/test/debugids.test.ts` and `sdk/sourcemaps/test/react-native.test.ts`, `bash -n` / `node --check` of the existing-lgtm e2e scripts, `lychee --offline`. The existing-lgtm e2e run itself (`tests/e2e/existing-lgtm/run.sh`) was not run: it only renames the tenant and the fake client's service name.
- Still to scrub, outside this PR: the open PRs #159, #163, #164, #166, #167 carry the name in their diffs (each needs the same replacement when rebased); the titles or bodies of PRs #154–#157, #159 and #162–#168 mention it (GitHub search). Those are the founder's to edit.
