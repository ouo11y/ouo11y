# Step 5 SDK audit brief (shared by the four platform auditors)

The brief each auditor worked from, kept as it was given. `<repo>` was this repository at 3e9e2c11; `<scratch>` a session scratch folder. The outputs are the `audit-*.json` files next to this one.

Repo checkout (read-only for you): <repo>
Do NOT edit any file in the repo. Do not commit, push, or change branches. Write only your output file in
<scratch>/
(and any scratch files under a subfolder named after your platform there).

## Inputs

- The draft spec: project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md (read sections 0-15 in full).
- requirements.json (in the scratchpad step5 folder): all 199 requirement ids with level and text. The level is the
  statement's strongest keyword; if a statement mixes MUST and SHOULD clauses, grade it as a whole and say which
  clause fails in the note. SIG-01..SIG-27 table rows are MUST through SIG-00.
- features.json: the Step 4 target list (125 features; Must, Should, Later, Never; "where" W = web, M = mobile, all).
- Do NOT trust project/kb-archive/ or old docs/specs as truth. Read the code.

## Method

For every requirement, decide for YOUR platform:
- `met`, `partial`, `not_met`, or `na` (not applicable to this platform; say why in one phrase).
- `evidence`: one or more `path:line` (repo-relative) pointing at the code that shows it (or, for not_met, the code
  that does something else, or "no code found" plus what you grepped).
- `method`: `read` (read code), `test` (ran a test that exercises it, name it), `wire` (observed real OTLP output).
  Running the SDK's existing unit tests is cheap and encouraged where it settles a question; say which test.
  Always bound long commands: the Mac has no `timeout`; use `perl -e 'alarm 600; exec @ARGV' <cmd>`.
- `note`: one short sentence: what is there, what is missing. Name the actual attribute/event names the SDK emits
  when they differ from the spec (this is the most common failure: MVP SDK names predate the spec).

Be strict and literal. "partial" means a real part of the rule holds; name the part that fails. If the SDK emits a
different event name or puts an attribute on the resource instead of the record, that is not_met for the naming rule.

Also list `violations`: things the SDK does that the spec forbids or does not allow (e.g. sends to a non-OTLP
endpoint, custom JSON format, attributes not prefixed `ouo.`, `unload` handlers, element text, cookies, metrics,
span events, device.id on resource, etc.), each with evidence and the requirement id it breaks.

Then `features`: for every Must and Should row of features.json that applies to your platform (by "where"),
our current state: `full`, `partial`, `none`, with evidence path:line and a one-line note. Also do Later/Never
rows only if the SDK actually ships them (state `full`/`partial`, note "ships a Later/Never feature").

## Output

One JSON file `audit-<platform>.json`:

```json
{
  "platform": "web|ios|android|rn",
  "sdk_paths": ["sdk/..."],
  "sdk_version": "x.y.z from package metadata",
  "how_checked": "what you read, which test commands you ran and their pass/fail counts",
  "requirements": [{"id":"SES-1","status":"met","evidence":["sdk/browser/src/session/manager.ts:42"],"method":"read","note":"..."}],
  "violations": [{"what":"...","evidence":["..."],"breaks":"REL-2"}],
  "features": [{"id":"SES-a","state":"partial","evidence":["..."],"note":"..."}],
  "architecture_notes": "5-10 sentences: how the SDK is built (OTel SDK or custom, exporter, queues, persistence, replay format, endpoints), the biggest structural gaps against the spec"
}
```

Every one of the 199 ids must appear exactly once. Validate with
`python3 -c "import json;d=json.load(open('audit-<platform>.json'));print(len(d['requirements']))"`.

Final message: under 200 words: counts by status for MUST rows, the five worst gaps, and the output path.
Never kill processes by pattern (no pkill/killall); stop only PIDs you started. Do not use a physical iPhone.
