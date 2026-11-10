# datadog / wire-format / fixtures / ios

| Path | What it is |
|---|---|
| [logs-batch.json](logs-batch.json) | iOS logs: JSON array body |
| [replay-full-snapshot.json](replay-full-snapshot.json) | Mobile wireframes: Meta, Focus, full snapshot (type 10) with shape, text and placeholder wireframes, masked |
| [replay-incremental-mutation.json](replay-incremental-mutation.json) | Incremental record (type 11, source 0) updating one text wireframe |
| [replay-two-segments.json](replay-two-segments.json) | One request carrying two segments (`file0`, `file1`) and an `event` metadata array |
| [rum-batch.json](rum-batch.json) | iOS RUM batch: deflate body, `DD-*` headers, view, view_update, app_launch vital, native resource |
