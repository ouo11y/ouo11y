# sdk-state scripts

Standard-library Python. Run from the repo root, in this order, after changing anything in `../findings/` or `../measure/*/results/`.

| Script | What it does |
|---|---|
| [build_gaps.py](build_gaps.py) | Joins the four audits with Step 4's Sentry vendor rows into `findings/gaps.json` |
| [summarize_overhead.py](summarize_overhead.py) | Reduces the raw harness results and `findings/budgets.json` to `findings/overhead.json` (medians, ranges, chart rows) |
| [build_report.py](build_report.py) | Writes `project/kb/client-sdk-state/sdk-state-report.html` from `findings/`; `--check` fails when the report is stale |
| [report_template.html.in](report_template.html.in) | The report's page and client-side tables |
