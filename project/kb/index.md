# Knowledge base

The knowledge base for the post-MVP work. Add one line here for every file you add. The hierarchy and folder names are still to be decided.

MVP-era knowledge is in [kb-archive](../kb-archive/index.md). It was mostly written by AI without founder review, so check anything you take from it before relying on it.

| File | Question it answers |
|---|---|
| [otel-common-model.md](otel-common-model.md) | What do all OTel signals share: versions read, Resource and Scope nesting, AnyValue, attribute limits, trace identity and `traceparent`, timestamps and clock skew, stability? |
| [otlp-protocol.md](otlp-protocol.md) | How does telemetry travel: HTTP and JSON rules, partial success, retries, compression, size limits, and where real servers differ from the spec? |
| [otel-logs-model.md](otel-logs-model.md) | What is a log record field by field, what makes it an Event, what can the body hold, and where does OTEP 4430 really stand? |
| [otel-traces-model.md](otel-traces-model.md) | What is a span field by field: kinds, status, links, sampling, and why are long-lived or never-ended spans a client-side problem? |
| [otel-metrics-model.md](otel-metrics-model.md) | How do instruments become data points, what are the point types, and why are temporality and cardinality hard for browsers? |
| [otel-signal-choice-and-backends.md](otel-signal-choice-and-backends.md) | Log, span or metric: measured wire cost, trade-offs, and how Loki, Tempo, Mimir and the Victoria stack store each one? |
| [otel-step2-questions.md](otel-step2-questions.md) | What must Step 2 decide about web vitals, errors, clicks, navigation, sessions and replays? |
