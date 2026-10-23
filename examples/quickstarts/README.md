# Quickstarts

Small, standalone apps that show ouo end to end, from an empty folder to the trace in Grafana.
They run against the one-file stack,
[`deploy/compose/quickstart.yaml`](../../deploy/compose/quickstart.yaml). The step-by-step
adoption guides for your own stack are in [`../fast-tracked/`](../fast-tracked/index.md).

| Quickstart | What it shows |
|---|---|
| [tiny-shop](tiny-shop/README.md) | Express API with the OpenTelemetry Node SDK (auto + manual spans) and a React app with `@ouo11y/browser`: one trace from the click to the API's manual spans, tagged with the RUM session; errors, a crash, replay |

## How a quickstart is built

Every quickstart has the same shape, so a reader always knows where to look:

```
examples/quickstarts/<name>/
├── README.md                  what it shows, and how to run result/ as is
├── build-it-yourself-guide.md the main path: build the app by hand, one step at a time
├── files/                     optional: files too many or too long to embed (see below)
└── result/                    the finished app, exactly what the guide ends with
```

1. **`build-it-yourself-guide.md` is the quickstart.** It starts from an empty folder and
   writes every file by hand: the plain app first, with no telemetry, then the stack, then the
   instrumentation, one step and one command block at a time. Each step ends with something
   the reader can see (a page, a trace, a log line). It ends with clean-up and a
   "when something does not work" table.
2. **Long files go in collapsible sections**, not in a folder to clone. Configuration such as
   `compose.yaml`, an OpenTelemetry Collector config or a `.env` goes inside a GitHub
   `<details>` block with a `<summary>` naming the target path. The reader opens it, copies
   it and pastes it into the file:

   ````markdown
   <details>
   <summary><code>stack/compose.yaml</code> (click to open)</summary>

   <!-- embed: deploy/compose/quickstart.yaml -->
   ```yaml
   ...
   ```

   </details>
   ````

3. **A copy of a repo file is checked, never edited by hand.** The
   `<!-- embed: <repo path> -->` line right before the fenced block makes
   [`check-embeds.mjs`](check-embeds.mjs) fail CI when the block differs from that file. After
   changing the source file, refresh every guide:

   ```bash
   node examples/quickstarts/check-embeds.mjs --write
   ```

4. **`files/` is for the rare case of many files.** When a step needs more files than a few
   collapsible sections can hold, put them in `files/` and have the guide copy them in.
5. **`result/` is what the reader has at the end.** It runs on its own, inside or outside this
   repo. It installs the published ouo packages (for example `@ouo11y/browser` from npm), not
   the workspace sources, because that is what a reader of the guide gets. Readers who get stuck
   compare their files with it, and the README runs it for anyone who wants to skip the guide.
6. **Published things only.** Released images (`ghcr.io/ouo11y/*`) and npm packages; never
   "clone the repo and build the SDK".
